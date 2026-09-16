# Host 侧 WebRTC 实现 A/B 定论

日期：2026-09-16

## 这份文档回答什么

`spec001.9` 的 Host 侧 WebRTC 实现，到底用 `node-datachannel`（libdatachannel）还是 `werift`。

结论一句话：**用 werift。libdatachannel 出局。**

## 怎么测的

脚本：`apps/codingns-proxy/local/webrtc-datachannel-demo/ab-bench.mjs`
原始数据：同目录 `ab-bench-result.json`

跑法：5 MB / 20 MB 两档，每档每个实现各 5 轮，**两档都交替跑**（每轮交换两个实现的执行顺序）。
每一轮都是全新的信令连接 + 全新 PeerConnection，轮与轮之间留 1.2 秒冷却。

判定口径只有一条：
**上行吞吐只认 Host 侧实测**（收到首字节 → 收完的耗时），页面侧报的「上传完成」不计入结论。
原因见 `20260916-WebRTC承载层验证结论.md` 3.1 节。

## 结果

| 实现 | 通过率 | 上行吞吐（Host 实测，成功轮） | 下行吞吐 |
| --- | --- | --- | --- |
| **werift** | **10/10（0% 失败）** | 2.84 ~ 23.27 MB/s，平均 11.12 | 23.39 ~ 31.52 MB/s，平均 28.32 |
| node-datachannel | **6/10（40% 失败）** | 18.94 ~ 43.20 MB/s，平均 32.31 | 41.02 ~ 46.00 MB/s，平均 43.76 |

按数据量分档：

| 数据量 | werift 通过 | werift 上行 | libdatachannel 通过 | libdatachannel 上行 |
| --- | --- | --- | --- | --- |
| 5 MB | 5/5 | 5.29 / 9.97 / 2.84 / 5.79 / 13.71（平均 7.52） | 4/5 | 24.97 / 18.94 / 26.58 / 39.07（平均 27.39） |
| 20 MB | 5/5 | 7.59 / 23.27 / 8.88 / 11.73 / 22.15（平均 14.72） | 2/5 | 41.09 / 43.20（平均 42.15） |

## 失败长什么样

libdatachannel 的 4 次失败，**全部是同一个特征**：

- 浏览器侧 `connectionState` 停在 `failed`
- ICE 从 `completed` 直接跳到 `failed`，没有经过 `disconnected`
- 底层没有 SCTP 报错，Host 进程自己还活着（这轮没触发 `cleanup timeout` 那个杀进程的异常）

这跟上一轮验证记录的特征一致，不是这次环境造成的偶发。

## 判定

**吞吐差距是真的，可靠性差距也是真的，这里必须二选一。**

- libdatachannel 上行快 3~4 倍（平均 32.31 vs 11.12 MB/s），下行也快约 1.5 倍
- 但它 **40% 的失败率是不可接受的**：用户点一次「上传」，五分之二的概率连不上

上行慢是可以绕的（错峰、分片、提示进度），连不上是绕不过去的。

所以：**Host 侧固定 werift，node-datachannel 不进入生产依赖。**

## 一个必须说明的数字波动

这轮 werift 上行平均 11.12 MB/s，比上一轮记录的「3–6 MB/s」高不少，20 MB 档甚至到了平均 14.72。

原因是机器负载：上一轮验证时测试机有 VPN 和多浏览器在跑，load average ≈ 3.9；这轮轻得多。
**这恰好又一次说明为什么必须交替跑**——如果只跑一遍，很容易把「今天机器闲」当成「这个实现变快了」。

所以对外表述仍然用保守区间：**werift 上行按 3~15 MB/s 看待，跨真实网络只会更低**。
`design.md` 里「上行 3–6 MB/s」这个偏保守的数字不用改，宁可低估。

## 备选方案：协议层重传，不选

任务清单里留过一条备选：如果两个实现都不能接受，就在协议层自己加序号 + 校验 + 重传，不依赖 SCTP。

**不采用，理由有两条：**

1. werift 已经证明可以做到 10/10 可靠，没有必要再造一层。
2. 那个备选方案的失败特征是 **ICE 连接整体 `failed`**，不是「个别分片丢了」。
   连接都没了，应用层重传没有意义——它解决的是「丢包」，而这里发生的是「断链」。
   要靠重传兜底，得先做自动重连 + 会话恢复，那是另一个量级的工程。

## 对后续的影响

- `design.md` 1.3 节「WebRTC 实现固定用 werift」这条判断成立，不用改
- Host 侧接入进程按 werift 写；`werift` 进 `apps/host` 依赖
- `node-datachannel` 只留在 demo 目录作为对照，不进入主仓库依赖
- PeerConnection 仍然必须独立进程：werift 是纯 JS，风险比 libdatachannel 低，
  但 `design.md` 8.2 节说的理由（WebRTC 状态机复杂，一个连接出问题不该带走整个 Host）依然成立

## 怎么复现

```bash
cd apps/codingns-proxy/local/webrtc-datachannel-demo
pnpm install --ignore-workspace
pnpm rebuild node-datachannel        # libdatachannel 需要这步才有二进制

node ab-bench.mjs --mb=5,20 --rounds=5
```

结果写在 `ab-bench-result.json`，控制台同时打印汇总表。

只跑单档、或者两个实现不交替，得到的结论不可信——这是这个项目已经踩过一次的坑。
