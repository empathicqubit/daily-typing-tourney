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

const opts = new firefox.Options();

const isProduction = process.argv[2] == '--production';

if(isProduction) {
    opts.addArguments('--headless');
}

const driver = new selenium.Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(opts)
    .build();

const getNewTournament = () => {
    return q.resolve()
        .then(() => driver.get('https://10fastfingers.com/login'))
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
        .then(() => driver.findElement(By.css('#share-link a')).getAttribute('href'));
}

const getLastTournamentMessage = () => {
    return q.resolve()
        .then(() => slack.search.messages({
            token: config.slack.token,
            query: `in:${config.slack.channelIds.join(',')} has:link 10fastfingers competition`,
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


            const users = _.times(rows.length, () => ({}));
            Array.from(rows.find('td.rank span')).forEach((rank, idx) => {
                try {
                    users[idx].rank = parseInt(rank.children[0].data);
                }
                catch(e) { }
            });

            Array.from(rows.find('td.username a')).forEach((username, idx) => {
                users[idx].username = username.children[0].data;
                users[idx].userHref = username.attribs.href;
            });

            Array.from(rows.find('td.wpm')).forEach((wpm, idx) => {
                try {
                    users[idx].wpm = parseFloat(wpm.children[0].data);
                }
                catch(e) { }
            });

            Array.from(rows.find('td.keystrokes')).forEach((keystrokes, idx) => {
                try {
                    users[idx].keystrokes = parseFloat(/[0-9\.]+/gi.exec(keystrokes.children[0].data)[0]);
                }
                catch(e) { }
            });

            Array.from(rows.find('td.tests_taken')).forEach((testsTaken, idx) => {
                try {
                    users[idx].testsTaken = parseFloat(testsTaken.children[0].data);
                }
                catch(e) { }
            });

            return users;
        });
};

const dayName = new Date().toLocaleString('en-US', { weekday: 'long' });

const maybePostMessage = (msg) => {
    if(!isProduction) {
        return q.resolve();
    }

    return q.all(config.slack.channelIds.map(channelId => {
        const final = Object.assign({
            unfurl_links: true,
            unfurl_media: true,
        }, msg, {
            token: config.slack.token,
            channel: channelId,
            username: config.slack.username,
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
        if(isProduction && msg && new Date(msg.message.ts * 1000).getDate() == new Date().getDate()) {
            if(!config.slack.ignoreLastTimestamp) {
                console.log('We already ran today!');
                debugger;
                process.exit(0);
                throw new Error('I shouldn\'t get here!!!');
            }
            else {
                return q.all([getLastTournamentResults(msg), getNewTournament(), maybePostMessage({ text: 'Please disregard the following messages!' })]);
            }
        }

        return q.all([getLastTournamentResults(msg), getNewTournament()])
    })
    .spread((r, tu) => (results = r, tournamentUrl = tu))
    .then(() => {
        const text = `Happy ${dayName}! Here are the results for the last tournament:` + results.map(result => `
#${result.rank}: *${result.username}* ${result.wpm}WPM`).join('');

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
    .then(() => driver.quit())
    .catch(e => {
        driver.quit();
        console.error(e);
        process.exit(1);
    });
