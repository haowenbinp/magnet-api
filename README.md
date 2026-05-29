# magnet-api

磁力片源抓取 + 影片元数据 API，为 iOS 视频播放器 App 提供数据支撑。

---

## 快速启动（本地）

```bash
# 1. 进入项目目录
cd magnet-api

# 2. 安装依赖（仅 cheerio + node-fetch，无框架）
npm install

# 3. 配置环境变量
cp .env.example .env
# 用文本编辑器打开 .env，填入 TMDB_API_KEY

# 4. 启动服务
npm start
# → http://localhost:3000
```

---

## API 接口文档

### `GET /api/health`
服务健康检查。

```json
{ "status": "ok", "time": "2026-05-28T09:00:00.000Z" }
```

---

### `GET /api/search?q=关键词&page=1`
搜索磁力片源，聚合 1337x / nyaa / The Pirate Bay 三个数据源。

**参数:**
| 参数 | 必填 | 说明 |
|------|------|------|
| q    | ✅   | 搜索关键词（影片名，支持中英文） |
| page | ❌   | 页码，默认 1 |

**响应示例:**
```json
{
  "query": "Interstellar",
  "page": 1,
  "total": 12,
  "results": [
    {
      "source": "1337x",
      "title": "Interstellar (2014) 2160p 4K BluRay HDR10 HEVC DTS-HD MA",
      "magnet": "magnet:?xt=urn:btih:abc123...&dn=...",
      "size": "17.8 GB",
      "seeds": 342,
      "leeches": 28,
      "health": 5,
      "quality": "4K",
      "codec": "H.265",
      "hdr": "HDR10",
      "audio": "DTS-HD MA"
    }
  ]
}
```

**health 字段说明（种子健康度 1-5）:**
| 值 | 含义 |
|----|------|
| 5  | 极佳（100+ 做种）|
| 4  | 良好（30-99 做种）|
| 3  | 一般（10-29 做种）|
| 2  | 较差（3-9 做种）|
| 1  | 极差（< 3 做种）|

---

### `GET /api/meta?title=影片名&year=年份`
获取影片元数据：封面、演员、简介、评分等。

**参数:**
| 参数  | 必填 | 说明 |
|-------|------|------|
| title | ✅   | 影片名（建议英文原名，匹配更准确）|
| year  | ❌   | 上映年份，用于精确匹配 |

**响应示例:**
```json
{
  "tmdbId": 157336,
  "title": "星际穿越",
  "originalTitle": "Interstellar",
  "year": "2014",
  "overview": "地球即将走向终结...",
  "poster": "https://image.tmdb.org/t/p/w500/xxx.jpg",
  "backdrop": "https://image.tmdb.org/t/p/w1280/xxx.jpg",
  "rating": "8.4",
  "voteCount": 35820,
  "runtime": "2h 49m",
  "runtimeMin": 169,
  "genres": ["科幻", "冒险", "剧情"],
  "directors": ["克里斯托弗·诺兰"],
  "cast": [
    {
      "name": "马修·麦康纳",
      "character": "库珀",
      "photo": "https://image.tmdb.org/t/p/w185/xxx.jpg"
    }
  ],
  "source": "tmdb"
}
```

---

## iOS App 对接方式

在 Swift 中调用示例：

```swift
// 搜索磁力链接
let url = URL(string: "http://你的服务器IP:3000/api/search?q=星际穿越")!
URLSession.shared.dataTask(with: url) { data, _, _ in
    guard let data = data,
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let results = json["results"] as? [[String: Any]] else { return }
    // 处理 results...
}.resume()

// 获取影片元数据
let metaUrl = URL(string: "http://你的服务器IP:3000/api/meta?title=Interstellar&year=2014")!
```

---

## 部署到云服务器（可选）

### Railway（推荐，免费额度充足）
```bash
# 安装 Railway CLI
npm install -g @railway/cli
railway login
railway init
railway up
```

### Render
1. 将项目推送到 GitHub
2. 登录 render.com → New Web Service
3. 选择仓库，Build Command: `npm install`，Start Command: `npm start`
4. 在 Environment Variables 中填入 TMDB_API_KEY

### 自有 VPS
```bash
# 安装 PM2 进程守护
npm install -g pm2
pm2 start server.js --name magnet-api
pm2 save && pm2 startup
```

---

## 注意事项

- 本项目仅用于个人学习与技术研究，请遵守所在地区法律法规
- TMDB API Key 请妥善保管，不要提交到 Git 仓库（.env 已在 .gitignore 中）
- 部分磁力站在国内需要代理访问，可在服务器上配置出口代理
