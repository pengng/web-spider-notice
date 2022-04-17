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

// 获取公众号订阅用户列表（非全部）
async function getSubscribes() {
    const query = new URLSearchParams({ access_token: TOKEN })
    const body = await fetch(`https://api.weixin.qq.com/cgi-bin/user/get?${query}`)
    const { errcode, errmsg, data: { openid: list } } = JSON.parse(body)
    if (errcode) throw new Error(errmsg)

    return list
}

/**
 * 发模板消息通知订阅用户
 * @param title 模板上显示的文案
 * @param link 模板点击后的跳转链接
 * @returns {Promise<void>}
 */
async function notice(title, link) {
    const subscribes = await retryWrapper(getSubscribes)()
    if (subscribes.length === 0) return console.warn('无任何订阅用户，请关注公众号')

    // 对于每条新消息，发模板通知每个已订阅用户
    while (true) {
        let item = subscribes.shift()
        let data = Object.assign({}, TPL, { touser: item, url: link, data: { title: { value: title, color: '#23cdb6'}} })
        let query = new URLSearchParams({ access_token: TOKEN })
        let url = `https://api.weixin.qq.com/cgi-bin/message/template/send?${query}`

        let { errcode, errmsg } = await post(url, data)
        if (errcode) throw new Error(errmsg)

        if (subscribes.length === 0) break

        // 间隔1秒再通知下个订阅用户，防止模板接口触发限制
        await new Promise(resolve => setTimeout(resolve, 1000))
    }
}

/**
 * 出错重试，默认3次
 * @param times 重试次数
 * @returns {(function(): Promise<*|undefined>)|*}
 */
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

/**
 * 专用于《广东省教育考试院》列表页的采集器
 * @param url 要采集的页面链接
 * @returns {Promise<{date: string, title: string, url: string}[]>}
 */
async function grabber1(url) {
    console.log(`正在尝试抓取【广东省教育考试院】公告`)
    let result = await retryWrapper(fetch)(url)

    let $ = cheerio.load(result)
    let list = $('.main .content ul.list li')

    // 采集器需要返回统一格式的对象数组
    list = Array.from(list).map(item => ({
        url: $(item).find('a').attr('href'),
        title: $(item).find('a').text(),
        date: $(item).find('span.time').text()
    }))

    return list
}

/**
 * 专用于《深圳大学》通告列表页的采集器
 * @param url 要采集的页面链接
 * @returns {Promise<{date: string, title: string, url: string}[]>}
 */
async function grabber2(url) {
    console.log(`正在尝试抓取【深圳大学】公告`)

    let result = await retryWrapper(fetch)(url)

    let $ = cheerio.load(result)
    let list = $('#content .articles ul li')

    list = Array.from(list).map(item => ({
        url: String(Object.assign(new URL(url), { pathname: $(item).find('a').attr('href') })),
        title: $(item).find('a').text().replace('•', '').trim(),
        date: $(item).find('span.datetime').text().match(/\d{4}-\d{2}-\d{2}/).shift()
    }))

    return list
}

// 将多个来源的采集器组合成数据生成器
async function* createProvider(providers) {
    let list = []
    let index = 0

    while (true) {
        if (list.length === 0) list = await providers[index++]().catch(() => [])
        index %= providers.length

        if (list.length) yield list.shift()

        // 每一轮爬取全部页面数据，然后间隔1小时后，再次爬取。
        if (list.length === 0 && index === 0) await new Promise(resolve => setTimeout(resolve, 1000 * 60 * 60))
    }
}

// 主程序
(async function main() {
    // 等待微信公众号的 access token 获取后，再开始爬取数据。
    // 避免要发送模板消息时，access token 不可用。
    await new Promise((resolve, reject) => manager.on('error', reject).on(EVENT_ACCESS_TOKEN, resolve))

    // 应用启动后默认获取当天及之后的新消息
    const NOW = new Date().setHours(0, 0, 0, 0)

    // 页面需要配套对应的采集器，相似的页面可以使用同一个采集器
    // 广东省教育考试院：1.普通高考通告列表页；2.自学考试通告列表页
    const providers1 = ['https://eea.gd.gov.cn/ptgk/index.html', 'https://eea.gd.gov.cn/zxks/index.html'].map(grabber1.bind.bind(grabber1, null))
    // 深圳大学：1.考务通告列表页；2.教务通告列表页
    const providers2 = ['https://csse.szu.edu.cn/zk/menu/29/list', 'https://csse.szu.edu.cn/zk/menu/28/list'].map(grabber2.bind.bind(grabber2, null))

    for await (let { title, url, date } of createProvider([...providers1, ...providers2])) {

        if (Date.parse(date) < NOW || LIST.includes(url)) continue

        await retryWrapper(notice)(title, url).catch(Function.prototype)
        console.log(`${title} <${url}>`)
        LIST.push(url)

        // 间隔5秒后，再通知下一条消息
        await new Promise(resolve => setTimeout(resolve, 5000))
    }
})()
