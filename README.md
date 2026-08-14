# dsh-quote-annotate

**选区引用与锚点批注** —— DeepSeek Harness（DSH）Web 插件，纯 Client、无 Host 逻辑。

## 解决了什么问题

DSH 会话中的消息**无法被选中、引用和批注**：你想针对上文某段内容提问或评论时，只能复制粘贴或口头描述"上面那部分"，模型无法精确知道你说的是哪一段。

本插件让"选中 → 批注 → 引用"成为一条完整链路：选中的文字变成**带锚点的引用 chip** 进入输入框，发送时序列化为结构化引用块，模型收到的评论**精确锚定在你引用的那段原文上**；输入框里的每个引用还能点击跳回原文位置、悬停查看原文。

## 功能

- **选中即批注**：鼠标选中会话中任意文字 → 选区上方浮出小气泡（宽度随文字增长）→ 点「批注」
- **悬浮编辑框**：引用预览 + 独立评论输入框（自动聚焦、元素常驻），随输入变宽；Enter 插入 / Esc 关闭
- **引用锚点 chip**：插入后草稿中显示 `引用#N` chip
  - **点击** → 平滑滚动回原文并高亮
  - **悬停** → 浮出提示框，显示当时选中的文字
- **提交序列化**：发送时 chip 展开为 `> 引用块` + 评论，模型收到结构化上下文
- **回合级引用**：每条已完成回合尾部有「引用提问 / 引用回答」按钮，整段引用该轮的提问或回答
- 全程走官方接口：`conversation.input` 输入机器、`inputTriggers` 引用管线（`quote-ref` source codec）、`slots` 注入（turnTail / shell.overlay）

## 安装（一键，发给 Agent 即可）

把下面这段话直接粘贴给 DSH 助手：

> 请帮我安装 dsh-quote-annotate 插件：运行 `dsh plugin --profile web add dsh-quote-annotate`，然后重启一次 web 服务使插件生效（静态客户端插件在服务启动时加载，重启后或下次启动时生效）。

手动安装（可选）：

```sh
dsh plugin --profile web add dsh-quote-annotate   # 从 npm 安装
dsh plugin --profile web add ./dsh-quote-annotate  # 或本地目录
dsh --profile web --dump-config                    # 确认出现 # == dsh-quote-annotate 层
```

要求：DSH Web 界面（官方 web profile 自带 `ui-input-trigger` 引用管线）；管线缺失时自动回退为纯文本引用插入。

## 说明

- 引用映射（ref → 原文位置）存于浏览器内存，刷新页面后失效（chip 退化为纯文本）
- 评论输入框的输入法语言行为取决于操作系统/输入法，插件已做元素常驻复用优化
- 有产出文件的回合会让位给官方「已生成文件」chips
