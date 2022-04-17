const https = require('https')
const cheerio = require('cheerio')
const WeixinTokenManager = require('weixin-token')
const TPL = require('./tpl.json')
const weixinConfig = require('./config.json')
const { EVENT_ACCESS_TOKEN } = WeixinTokenManager

let LIST = []
let TOKEN = ''
let manager = new WeixinTokenManager([weixinConfig])

manager.on(EVENT_ACCESS_TOKEN, ({ access_token }) => TOKEN = access_token)
manager.on('error', err => console.error(err))

async function fetch(url) {
    let response = await new Promise((resolve, reject) => https.get(url, resolve).on('error', reject))
    let chunks = []

    await new Promise((resolve, reject) => response.on('error', reject).on('end', resolve).on('data', chunks.push.bind(chunks)))

    let body = Buffer.concat(chunks).toString()
    return body
}

async function post(url, data) {
    data = typeof data === 'string' ? data : JSON.stringify(data)

    let response = await new Promise((resolve, reject) => https.request(url, { method: 'POST' }, resolve).on('error', reject).end(data))
    if (response.statusCode !== 200) throw new Error(`未支持的状态码：${response.statusCode}`)

    let chunks = []

    await new Promise((resolve, reject) => response.on('error', reject).on('end', resolve).on('data', chunks.push.bind(chunks)))

    let body = JSON.parse(Buffer.concat(chunks))
    return body
}

async function getSubscribes() {
    const query = new URLSearchParams({ access_token: TOKEN })
    const body = await fetch(`https://api.weixin.qq.com/cgi-bin/user/get?${query}`)
    const { errcode, errmsg, data: { openid: list } } = JSON.parse(body)
    if (errcode) throw new Error(errmsg)

    return list
}

async function notice(title, link) {
    const subscribes = await retryWrapper(getSubscribes)()
    if (subscribes.length === 0) return console.warn('无任何订阅用户，请关注公众号')

    while (true) {
        let item = subscribes.shift()
        let data = Object.assign({}, TPL, { touser: item, url: link, data: { title: { value: title, color: '#23cdb6'}} })
        let query = new URLSearchParams({ access_token: TOKEN })
        let url = `https://api.weixin.qq.com/cgi-bin/message/template/send?${query}`

        let { errcode, errmsg } = await post(url, data)
        if (errcode) throw new Error(errmsg)

        if (subscribes.length === 0) break
        await new Promise(resolve => setTimeout(resolve, 1000))
    }
}

function retryWrapper(fn, times = 3) {
    return async function() {
        for (let i = 0; i < times; i++) {
            try {
                return await fn.apply(this, arguments)
            } catch (e) {
                console.error(e.message)
                await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, i)))
            }
        }
    }
}

async function website1() {
    console.log(`正在尝试抓取【广东省教育考试院】公告`)
    let result = await retryWrapper(fetch)('https://eea.gd.gov.cn/zxks/index.html')

    let $ = cheerio.load(result)
    let list = $('.main .content ul.list li')

    list = Array.from(list).map(item => ({
        url: $(item).find('a').attr('href'),
        title: $(item).find('a').text(),
        date: $(item).find('span.time').text()
    }))

    return list
}

async function website2(urlpage) {
    console.log(`正在尝试抓取【深圳大学】公告`)

    let result = await retryWrapper(fetch)(urlpage)

    let $ = cheerio.load(result)
    let list = $('#content .articles ul li')

    list = Array.from(list).map(item => ({
        url: String(Object.assign(new URL(urlpage), { pathname: $(item).find('a').attr('href') })),
        title: $(item).find('a').text().replace('•', '').trim(),
        date: $(item).find('span.datetime').text().match(/\d{4}-\d{2}-\d{2}/).shift()
    }))

    return list
}

async function* createProvider() {
    const pages = ['https://csse.szu.edu.cn/zk/menu/29/list', 'https://csse.szu.edu.cn/zk/menu/28/list']
    const providers = [website1, ...pages.map(url => website2.bind(null, url))]
    let list = []
    let index = 0

    while (true) {
        if (list.length === 0) list = await providers[index++]().catch(() => [])
        index %= providers.length

        if (list.length) yield list.shift()

        if (list.length === 0 && index === 0) await new Promise(resolve => setTimeout(resolve, 1000 * 60 * 60))
    }
}

(async () => {
    await new Promise((resolve, reject) => manager.on('error', reject).on(EVENT_ACCESS_TOKEN, resolve))

    const NOW = new Date().setHours(0, 0, 0, 0)

    for await (let { title, url, date } of createProvider()) {

        if (Date.parse(date) < NOW || LIST.includes(url)) continue

        await retryWrapper(notice)(title, url).catch(Function.prototype)
        console.log(`${title} <${url}>`)
        LIST.push(url)
        await new Promise(resolve => setTimeout(resolve, 5000))
    }
})()
