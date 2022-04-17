# 网页爬虫 + 微信公众号模板消息通知 web-spider-notice

### 运行示例
```shell
git clone https://github.com/pengng/web-spider-notice.git

cd web-spider-notice                    # 进入项目
cp config.json.sample config.json       # 生成配置文件（需要手动二次修改）
npm install                             # 安装依赖的 npm 包
npm start                               # 开始运行
```

### 完成《广东省教育考试院》和《深圳大学》共4个通告列表页的2个数据采集器，相似页面可复用同一个采集器

```javascript
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

// 页面需要配套对应的采集器，相似的页面可以使用同一个采集器
// 广东省教育考试院：1.普通高考通告列表页；2.自学考试通告列表页
const providers1 = ['https://eea.gd.gov.cn/ptgk/index.html', 'https://eea.gd.gov.cn/zxks/index.html'].map(grabber1.bind.bind(grabber1, null))
```

### 当有新消息时，通过微信公众号模板消息通知已订阅的用户

```javascript
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
```

### 针对运行中可能出现的网络错误和接口异常增加了出错重试（3次）

```javascript
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

// 将请求函数增加出错重试
let result = await retryWrapper(fetch)(url)
```
