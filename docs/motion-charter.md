# Motion Charter — open-tag 动效宪法

> 后面所有动效子 agent 的剧本。规范层(不靠"看")由主 agent 定;实现+视觉迭代由子 agent 在真实页面录 GIF 自验闭环。
> 最终落地:token → `web/src/styles.css :root`;本宪法提炼进 `DESIGN.md` 的 Motion 章节(补 Known Gaps)。

## 1. 动效 token(复用现有曲线,别另造)

应用主体(`styles.css :root` 新增。落地页 `--lp-*` 自成体系,不动):

```css
/* easing —— 复用现有 + 补一条招牌曲线 */
--ease-quint: cubic-bezier(.22, 1, .36, 1);  /* 现有主力(tk-slot/switch/ahc-in)→ UI 默认 */
--ease-expo:  cubic-bezier(.16, 1, .3, 1);   /* 新增,animate.md「笃定」曲线 → 招牌进场 */
--ease-decel: cubic-bezier(0, 0, .2, 1);     /* 现有(lb-ping)→ 持续/扩散/循环 */

/* duration —— 贴现有 .12/.18/.22s,锚 product 的 150–250ms */
--dur-fast:      120ms;  /* press / caret / toggle —— 瞬时反馈 */
--dur-base:      200ms;  /* hover / 状态切换 / 视图过渡 */
--dur-slow:      320ms;  /* modal / drawer 进出 / 展开折叠 */
--dur-signature: 440ms;  /* 招牌进场(agent 上线 / 消息进场) */
```

## 2. 动效清单(分级)

### 招牌(过「你」这关,允许表现力)
| 动效 | 元素 | 动什么 | 时长 / 曲线 |
|---|---|---|---|
| **agent 醒来** | live-bar pip + 头像 | scale+blur+opacity 归位 + 光环扩散 | 440ms `--ease-expo` |
| **消息进场** | 新消息行 | opacity + translateY 微升(连发 stagger) | 320ms `--ease-quint` |
| **hero orb drift** | 落地页 gradient orbs | 缓慢漂移呼吸 | 长循环 `--ease-decel` |

### 次要(客观红线全绿即合格,克制,不劳你看)
按钮 press（scale .97 / `--dur-fast`）· caret 旋转（统一 `--dur-fast`）· 频道/视图切换 crossfade+微移（`--dur-base/--ease-quint`）· modal/drawer 进出（`--dur-slow`,统一现有散值）· 未读分隔线淡入（`--dur-base`）· toast/hovercard（已有,统一到 token）

## 3. 每个招牌的「设计意图描述」(= 实现 brief + 子 agent 自评对照标准)

**agent 醒来**：agent 从 offline→online 时,其头像从 `scale .85 + opacity .4 + blur 3px` 在 440ms 内 `--ease-expo` 归位清晰;同时 live-bar 状态 pip 从中心向外扩一圈细环(复用现有 `lb-ping` 思路,但单次非循环)。情绪:笃定地「醒来上线」,**不弹跳**。参照 Linear issue 状态切换的克制笃定感。

**消息进场**：新到的消息行从 `opacity 0 + translateY 6px` 在 320ms `--ease-quint` 落定;一次多条时按 60ms stagger 上限错峰(≤8 条,超出不再延迟)。情绪:消息「落」进来,轻、不抢眼。**只对真·新增的消息,不对滚动加载的历史**。

**hero orb drift**：落地页 hero 背后的 gradient orbs(mint/peach/lavender/sky)以 12–20s 周期、≤24px 幅度极缓漂移+轻微 scale 呼吸,彼此不同相位。情绪:氛围在「呼吸」,几乎察觉不到的活气,绝不喧宾夺主。纯装饰 → reduced-motion 下完全静止。

## 4. 客观红线(所有动效通用,子 agent 机械自判,全绿才算过)

1. **只动** `transform` / `opacity` / `filter`(grep 实现,**零** `width`/`height`/`top`/`left`/`margin` 动画)
2. 时长走 token,落在该档区间;**无** bounce / elastic 曲线
3. 用规范 easing token(应用主体 `--ease-*`,落地页 `--lp-ease`)
4. **reduced-motion 降级**:`@media (prefers-reduced-motion:reduce)` 下进场动效直显、循环动效静止
5. 布局不崩:动效前后静态帧对比无位移/截断
6. `npm run typecheck`(root + web)过

## 5. reduced-motion 策略

现有 5 处散写保留不动(surgical)。**新动效**统一进一个集中兜底块(进场→直显,循环→停),别再散落。

## 6. 验收 & 回传

子 agent 每个动效:写实现 → `~/.pw-tools/anim-capture.mjs` 录 GIF → Read 关键帧 → 对 §4 红线(逐条)+ §3 设计意图(吻合?差哪?)自评 → 不满意自己改,**最多 3 轮**,到顶带现状 GIF+卡点回传。
回传纯文字+路径:红线逐条结果 + 设计意图自评 + GIF 路径。主 agent 只核红线(没绿打回,不看图);招牌 GIF 交「你」做审美裁决。
