# DormMate M6 排错记录

记录 M6（Three.js 3D 数字空间）开发过程中的问题复现、根因分析与修复验证。

环境：Windows 11 + Chrome（Chromium 内核）+ `file://` 协议打开页面。
文中的控制台输出与像素统计数字均为实测捕获，复现方式见各案例。

---

## Bug 1：`file://` 下 ES module 被 CORS 拦截，3D 场景黑屏

**严重程度**：阻塞级（页面完全无内容）
**来源**：开发前用最小复现页验证 `file://` 的加载行为时发现，直接决定了本模块的架构选型

### 现象

按 three.js 官方文档的现代写法组织代码——把场景逻辑拆成独立 `.js` 文件，
用 `<script type="module">` 引入：

```html
<!-- 复现用的最小页面 -->
<script type="module">
  import { PROBE } from './mod.js';
  document.title = 'OK: ' + PROBE;
</script>
```

用 Live Server 打开一切正常；**双击用 `file://` 打开则脚本完全不执行**，标题停留在初始值，
实际项目中表现为 canvas 从未创建、3D 场景区域一片黑。

### 控制台报错原文

```
Access to script at 'file:///C:/Users/hexin/AppData/Local/Temp/m6_probe/mod.js'
from origin 'null' has been blocked by CORS policy: Cross origin requests are
only supported for protocol schemes: chrome, chrome-untrusted, data, http, https.
```
```
Failed to load resource: net::ERR_FAILED
```

### 根因

`file://` 页面的 origin 是 `null`（不透明源）。ES module 的 `import` 一律走 CORS 校验，
而 Chrome 明确只允许 `http/https/data/chrome` 等协议参与跨源脚本加载——`file://` 不在白名单里，
所以本地 js 文件必然被拒。

这也是本模块约束「必须双击打开、禁止 Live Server」的直接技术原因：
Live Server 会起一个 http 服务，反而让上面的错误写法"看起来能跑"，
一旦交付给老师用双击方式打开就会立刻黑屏。

**关键区分**：从 `file://` 页面用 `type="module"` 加载 **https CDN** 是允许的
（实测 `import * as THREE from 'https://unpkg.com/three@0.128.0/build/three.module.js'` 成功，`THREE.REVISION = 128`），
被拦截的只是**本地文件**。但为了不把这个隐含依赖留给浏览器版本差异，最终仍选择 UMD 方案。

### 修复

全部改用 UMD 构建 + 普通 `<script src>`，并把场景逻辑内联在 HTML 中，
不产生任何本地 js 文件的跨源加载：

```html
<script src="https://unpkg.com/three@0.128.0/build/three.min.js"></script>
<script src="https://unpkg.com/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
<script src="https://unpkg.com/mqtt/dist/mqtt.min.js"></script>
<script>
  // 普通脚本，直接使用全局的 window.THREE / window.mqtt
</script>
```

同时加了依赖检查：若 `THREE` 或 `mqtt` 未定义（CDN 被墙、断网），
页面显示明确的文字提示而不是黑屏。

### 修复验证

`3d/index.html` 用 `file://` 打开：`THREE r128 / mqtt object / OrbitControls function` 全部就绪，
canvas 数量为 1，控制台无错误。

---

## Bug 2：把 Node.js 的 `require` 用在浏览器里

**严重程度**：阻塞级（脚本第一行就抛错）
**来源**：对照实验——验证"模块引入方式写错"时的具体故障表现

### 现象

three.js 的很多教程是 Node 环境（`npm install three`）写法，直接照搬到浏览器会这样写：

```html
<script src="https://unpkg.com/three@0.128.0/build/three.min.js"></script>
<script>
  const THREE = require('three');   // 错误：浏览器没有 require
  const scene = new THREE.Scene();
</script>
```

### 控制台报错原文

```
pageerror: Error: require is not defined
```

标题停在初始值，`document.querySelectorAll('canvas').length === 0`——场景一步都没走下去。

### 根因

`require` 是 CommonJS（Node.js）的模块加载函数，浏览器原生环境里不存在。
引入了 UMD 版 `three.min.js` 后，`THREE` 已经作为全局变量挂在 `window` 上，
再声明 `const THREE = require(...)` 既多余又会立即抛错。

### 修复

删掉 `require`，直接使用全局对象：

```js
var scene = new THREE.Scene();   // THREE 来自 <script src> 注入的全局变量
```

### 修复验证

`3d/index.html` 中所有 three.js API 都直接调用全局 `THREE`，页面无 `require` 相关报错。

---

## Bug 3：用 `setInterval` 写渲染循环，导致 WebGL 上下文耗尽、页面卡死闪烁

**严重程度**：致命（页面数秒内卡死，且会拖垮整个浏览器标签页）
**来源**：对照实验——验证渲染循环的错误写法后果

### 现象

把渲染循环写成定时器，并且**每一帧都重新创建 `renderer` / `scene` / `camera`**：

```html
<script>
  setInterval(function () {
    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(75, 800 / 600, 0.1, 1000);
    var renderer = new THREE.WebGLRenderer();   // 每 50ms 新建一个渲染器！
    renderer.setSize(400, 300);
    document.body.appendChild(renderer.domElement);   // 每 50ms 往页面塞一个 canvas
    renderer.render(scene, camera);
  }, 50);
</script>
```

### 控制台报错原文

实测运行 4 秒的结果：**canvas 累积到 80 个**（`renders=80 canvases=80`），并持续刷屏：

```
WARNING: Too many active WebGL contexts. Oldest context will be lost.
THREE.WebGLRenderer: Context Lost.
[.WebGL-0x...]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels
```

### 根因

浏览器对同时存在的 WebGL 上下文数量有硬上限（约 16 个）。
每 50ms 新建一个 `WebGLRenderer` 就等于每 50ms 申请一个上下文：
超过上限后浏览器开始强制回收最旧的上下文，`Context Lost` 出现，
画面表现为剧烈闪烁直至完全卡死。同时 DOM 里堆积大量 canvas，内存持续上涨。

即使不重建 `renderer`，`setInterval` 本身也不适合做渲染循环——
它不感知浏览器绘制时机，切换标签页或掉帧时会与刷新率错位，产生抖动。

### 修复

**初始化只做一次，循环只更新属性**，用 `requestAnimationFrame` 驱动：

```js
// 初始化阶段（只执行一次）
var renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
container.appendChild(renderer.domElement);

var scene = new THREE.Scene();
var camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 200);

// 渲染循环：只改属性，绝不重建对象
function animate(time) {
    requestAnimationFrame(animate);
    // 用帧间隔 dt 计算转速，保证不同刷新率下转速一致
    bladeGroup.rotation.z += anim.fanSpeed * dt * 12;
    controls.update();
    renderer.render(scene, camera);
}
requestAnimationFrame(animate);
```

顺带解决了一个隐藏问题：旋转量用 `+= speed * dt` 按时间累积，
而不是 `+= 固定值`，这样 60Hz 和 144Hz 屏幕上风扇转速一致。

### 修复验证

`3d/index.html` 运行 9 秒以上，`document.querySelectorAll('canvas').length === 1`，
无 `Too many active WebGL contexts` / `Context Lost` 告警，风扇旋转流畅。

---

## Bug 4：指示灯自发光过强，颜色被冲淡到接近白色

**严重程度**：功能缺陷（画面仍有变化，但颜色语义丢失）
**来源**：M6 场景重写为室内宿舍后，用像素颜色统计做验收时发现

### 现象

场景重写后指示灯按要求设为「正常绿 / 偏热红 / 偏湿蓝」。
肉眼粗看画面确实在变，但用脚本统计截图中高饱和度颜色像素时得到：

| status | 红色像素 | 绿色像素 | 蓝色像素 |
| --- | --- | --- | --- |
| 正常 | 3396 | 1337 | 0 |
| 偏热 | 11205 | 0 | 0 |
| 偏湿 | 3396 | 0 | **0** |
| 偏冷 | 3396 | 0 | 0 |

偏湿状态的指示灯明明是蓝色，**蓝色像素却是 0**；偏湿与偏冷的统计完全一致（3396/0/0），
两者截图差异仅 0.31%——说明这两个状态在视觉上几乎没有区别，颜色语义已经丢失。

### 根因

指示灯用的是受光材质叠加自发光：

```js
var lampMat = new THREE.MeshLambertMaterial({
    color: 0x3b82f6,
    emissive: 0x3b82f6,
    emissiveIntensity: 1.35      // ← 问题出在这里
});
```

Lambert 材质的最终颜色约等于 `color × 光照 + emissive × emissiveIntensity`。
场景里环境光（0.62）与方向光本身已把漫反射项推得较亮，
再叠加 1.35 倍自发光，三个通道一起冲到上限，结果就是**接近纯白**。

白色不再满足"蓝 > 红+25 且 蓝 > 绿+25"的判定，因此统计里蓝色像素为 0。
绿色指示灯因为色相在光照下更容易保持，还能勉强通过判定（1337 像素），
但蓝、琥珀这类色相就被完全冲掉了。

### 修复

指示灯本身就是发光体，不该参与场景光照计算。改用不受光照影响的材质：

```js
var lampMat = new THREE.MeshBasicMaterial({ color: 0x22c55e });
// 每帧只改 color，不再有 emissive 叠加导致的过曝问题
lampMat.color.copy(anim.lampColor);
```

同时把灯面板从 0.86×0.5 放大到 1.0×0.58，让状态变化更醒目。

### 修复验证

同样的像素统计，修复后：

| status | 红色像素 | 绿色像素 | 蓝色像素 |
| --- | --- | --- | --- |
| 正常 | 3390 | **1915** | 0 |
| 偏热 | **11759** | 0 | 0 |
| 偏湿 | 3390 | 0 | **1955** |
| 偏冷 | **5305** | 0 | 0 |

四个状态的颜色特征互不混淆：偏湿的蓝色从 0 变成 1955；
偏热比偏冷多出的约 6400 个红色像素，正是风扇整体变红贡献的部分。

---

## Bug 5：色彩空间处理不当导致画面过曝发白

**严重程度**：观感缺陷（功能正常，但画面"发白、发平"，看起来廉价）
**来源**：M6 场景视觉优化时，用亮度统计脚本量化画面质量时发现

### 现象

场景升级为 PBR 材质 + 阴影 + ACES 色调映射后，主观上仍然"不好看"，
但肉眼说不清问题出在哪里。于是写脚本统计画面的亮度分布（0–255）：

| 指标 | 数值 |
| --- | --- |
| 平均亮度 | 142.4 |
| 过曝像素（亮度 > 225） | **48.0%** |
| 死黑像素（亮度 < 30） | 39.6% |

**近一半画面接近纯白**，两端极值合计占了 87.6%，中间调只剩 12%——
这就是画面"发白、发平、没有层次"的量化原因。

### 根因

渲染器同时设置了两件互相冲突的事：

```js
renderer.outputEncoding = THREE.sRGBEncoding;   // 输出阶段做 linear → sRGB 转换
renderer.toneMapping = THREE.ACESFilmicToneMapping;

var matWall = new THREE.MeshStandardMaterial({ color: 0xf1ece3 });   // ← 未做转换
```

在 three.js r128 中，材质颜色默认被当作**线性值**参与光照计算。
`0xf1ece3` 本身是一个 sRGB 数值，直接被当成线性值使用后，
输出阶段又执行了一次 linear → sRGB 转换，等于把亮度**多提了一档**。

浅色物体（墙面、床垫、桌腿）本来就接近白，叠加这一档提亮后直接被推到 255 封顶，
相互之间的明暗差别全部被压平——所以看起来"糊成一片"。

### 修复

两种正确做法（本质上都要保证颜色只被转换一次）：

1. 保留 sRGB 输出，把所有材质颜色 `convertSRGBToLinear()`
2. 不做 sRGB 输出，依赖 ACES 色调映射提供高光滚降

本项目采用第 2 种，改动面小、不易漏改：

```js
// 不使用 sRGBEncoding 输出，否则材质色需全部转线性，
// 否则整体会被提亮一档导致过曝
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.32;
```

> 若选做法 1，则 `matte()` 辅助函数里加一行 `m.color.convertSRGBToLinear()` 即可，
> 但要记得**灯光颜色、背景色、雾的颜色也要一并转换**，漏掉任何一处都会重新引入偏色。

顺带做的第二处调整：背景色 `#10151f`（亮度约 21）本身低于死黑阈值，
导致 39.6% 的像素被判为纯黑。提亮到 `#1b2431` 后画面明显透气。

### 修复验证

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| 平均亮度 | 142.4 | 135.3 |
| 过曝像素（> 225） | 48.0% | **0.4%** |
| 死黑像素（< 30） | 39.6% | **0.0%** |

所有像素都落在 30–225 的可用区间内，墙面、床垫、桌面之间恢复了明暗层次。

---

## 附：五个案例的对比

| | Bug 1 | Bug 2 | Bug 3 | Bug 4 | Bug 5 |
| --- | --- | --- | --- | --- | --- |
| 触发层 | 加载方式 / 协议 | 模块系统混用 | 渲染架构 | 材质与光照 | 色彩空间 |
| 报错特征 | `blocked by CORS policy` | `require is not defined` | `Too many active WebGL contexts` | 无报错，靠像素统计发现 | 无报错，靠亮度统计发现 |
| 页面表现 | 全黑无内容 | 全黑无内容 | 闪烁后卡死 | 颜色泛白、状态难分辨 | 画面过曝发平、无层次 |
| canvas 数量 | 0 | 0 | 4 秒内涨到 80 | 1（正常） | 1（正常） |
| 修复方向 | 换 UMD + 内联脚本 | 改用全局 `THREE` | 单次初始化 + rAF | 发光体改用 Basic 材质 | 去掉 sRGB 输出 / 转线性颜色 |
