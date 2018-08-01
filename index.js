const url = require('url');
const _ = require('lodash');
const selenium = require('selenium-webdriver');
const { By, Util, until } = selenium
const firefox = require('selenium-webdriver/firefox');
const slack = require('slack');
const cheerio = require('cheerio');
const config = require('./config/config');
const q = require('q');
const fetch = require('node-fetch');
const argv = require('yargs').argv;

require('geckodriver');

const isProduction = !!argv.production;

const notHeadless = !!argv.notheadless;

console.log('Production?', isProduction);
console.log('Run non-headless?', notHeadless);

const getNewTournament = () => {
    const opts = new firefox.Options();

    if(isProduction && !notHeadless) {
        opts.addArguments('--headless');
    }

    const driver = new selenium.Builder()
        .forBrowser('firefox')
        .setFirefoxOptions(opts)
        .build();

    let href;
    return q.resolve()
        .then(() => driver.get('https://10fastfingers.com/login'))

        // Effing GPDR
        .then(() => driver.wait(until.elementsLocated(By.css(".cc-dismiss"))))
        .then(() => driver.findElement(By.css('.cc-dismiss')).click())

        .then(() => driver.findElement(By.css('.social-login.twitter-btn-tb')).click())
        .then(() => driver.wait(until.elementsLocated(By.css("#username_or_email"))))
        .then(() => driver.findElement(By.css('#username_or_email')).sendKeys(config.twitter.username))
        .then(() => driver.findElement(By.css('#password')).sendKeys(config.twitter.password))
        .then(() => driver.findElement(By.css('#oauth_form input[type="submit"]')).click())
        .then(() => driver.wait(until.urlContains('/typing-test/')))
        .then(() => driver.get('https://10fastfingers.com/competitions'))
        .then(() => driver.findElement(By.css('[href="#create-game"]')).click())
        .then(() => driver.findElement(By.css('#private-competition')).click())
        .then(() => driver.findElement(By.css('#speedtestid1')).click())
        .then(() => driver.findElement(By.css('#link-create-competition')).click())
        .then(() => driver.findElement(By.css('#share-link a')).getAttribute('href'))
        .then(h => (href = h, driver.quit()))
        .then(() => href)
        .catch((e) => {
            driver.quit();
            throw e;
        });
}

const getLastTournamentMessage = () => {
    return q.resolve()
        .then(() => slack.search.messages({
            token: config.slack.token,
            query: `in:${config.slack.channels.map(x => x.name).join(',')} has:link 10fastfingers competition`,
            sort: 'timestamp',
        }))
        .then(slackResults => {
            const slackMatches = slackResults.messages.matches;
            if(!slackMatches.length) {
                return [];
            }

            let attachment;
            let slackMatch;
            for (const m of slackMatches) {
                slackMatch = m;
                attachment = m.attachments.find(x => /\/10fastfingers.com\/competition\//gi.test(x.from_url));
                if(attachment) {
                    break;
                }
            }

            console.log('Last message', slackMatch);

            return attachment && slackMatch && {
                message: slackMatch,
                attachment: attachment,
            };
        });
};

const getLastTournamentResults = (msg) => {
    const urlPieces = new URL(msg.attachment.from_url).pathname.split('/');
    urlPieces.reverse();

    const hash = urlPieces.find(x => x);
    const params = new url.URLSearchParams();
    params.append('hash_id', hash);

    let users;
    return q.resolve()
        .then(() => fetch(`https://10fastfingers.com/competitions/get_competition_rankings`, {
            method: 'POST',
            body: params,
            headers: { 
                'Accept': '*/*',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
            },
        }))
        .then(r => r.text())
        .then(text => {
            const doc = cheerio.load(text);

            const rows = doc('#competition-rank-table tbody tr').has('td.tests_taken');


            users = _.times(rows.length, () => ({}));
            Array.from(rows.find('td.rank span')).forEach((rank, idx) => {
                try {
                    users[idx].rank = parseInt(rank.children[0].data);
                }
                catch(e) { }
            });

            Array.from(rows.find('td.username a')).forEach((username, idx) => {
                users[idx].username = username.children[0].data;
                users[idx].userHref = username.attribs.href;
            })

            Array.from(rows.find('td.wpm')).forEach((wpm, idx) => {
                try {
                    users[idx].wpm = parseFloat(wpm.children[0].data);
                }
                catch(e) { }
            });

            Array.from(rows.find('td.keystrokes')).forEach((keystrokes, idx) => {
                try {
                    users[idx].keystrokes = parseFloat((/[0-9\.]+/gi).exec(keystrokes.children[0].data)[0]);
                }
                catch(e) { }
            });

            Array.from(rows.find('td.tests_taken')).forEach((testsTaken, idx) => {
                try {
                    users[idx].testsTaken = parseFloat(testsTaken.children[0].data);
                }
                catch(e) { }
            });
        })
        .then(() => {
            return q.all(config.slack.channels.map(channel => {
                return slack.conversations.members({
                    token: config.slack.token,
                    channel: channel.id,
                });
            }));
        })
        .then(channels => {
            const promises = 
                _(channels)
                .map(x => x.members)
                .flatten()
                .map(memberId => 
                    slack.users.info({
                        token: config.slack.token,
                        user: memberId,
                    })
                )
                .value();

            return q.all(promises);
        })
        .then(members => {
            let done = false;
            for(const user of users) {
                for(const member of members) {
                    if(new RegExp(member.user.real_name.replace(/\s+/g, '.*'), 'gi').test(user.username)) {
                        user.slackId = member.user.id;
                        break;
                    }
                }
            }

            return users;
        });
};

const dayName = new Date().toLocaleString('en-US', { weekday: 'long' });

const maybePostMessage = (msg) => {
    if(!isProduction) {
        console.log(msg);
        return q.resolve();
    }

    return q.all(config.slack.channels.map(channel => {
        const final = Object.assign({
            unfurl_links: true,
            unfurl_media: true,
        }, msg, {
            token: config.slack.token,
            channel: channel.id,
            username: config.slack.username,
            icon_url: config.slack.icon_url,
        });

        return slack.chat.postMessage(final);
    }));
}

let tournamentUrl;
let results;
q.resolve()
    .then(() => {
        if(!config.twitter.username || !config.twitter.password) {
            throw new Error('You must provide a TWITTER_USERNAME and TWITTER_PASSWORD');
        }

        return getLastTournamentMessage();
    })
    .then(msg => {
        const promises = [];

        const now = new Date();
        if(isProduction && msg && 
            (
                // No early
                now.getHours() < 5
                // No weekends
                || [0, 6].includes(now.getDay()) 
                || new Date(msg.message.ts * 1000).getDate() == now.getDate())
            ) {
            if(!config.slack.ignoreLastTimestamp) {
                console.log('We already ran today!');
                debugger;
                process.exit(0);
                throw new Error('I shouldn\'t get here!!!');
            }
            else {
                promises.push(maybePostMessage({ text: 'Please disregard the following messages!' }));
            }
        }

        promises.push(getLastTournamentResults(msg));
        promises.push(getNewTournament());
        return q.all(promises);
    })
    .spread((r, tu) => (results = r, tournamentUrl = tu))
    .then(() => {
        const text = `Happy ${dayName}! Here are the results for the last tournament:` + results.map(result => `
#${result.rank}: *${result.slackId ? `<@${result.slackId}>` : result.username}* ${result.wpm}WPM`).join('');

        return maybePostMessage({
            text: text,
        });
    })
    .then(() => {
        return maybePostMessage({
            text: `A new tournament is up at <${tournamentUrl}>!`,
        });
    })
    .delay(10000)
    .catch(e => {
        console.error(e);
        process.exit(1);
    });
