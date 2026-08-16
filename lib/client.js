// dsh-quote-annotate —— Client 半区（浏览器）
// 静态化自动态插件 quote-1/pkg-19（选区引用与锚点批注 v19）
window.__ModuleLoader__.load({
  id: 'dsh-quote-annotate',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    let React = require('react')

    // ============ 模块级状态 ============
    let rootCtx = null
    let currentSessionId = null
    let refSeq = 0
    let pipelineAvailable = null // null=未知 false=不可用 true=可用
    // ref -> { sessionId, anchorKey, body, label } 用于点击 chip 跳回原文 / 悬停显示原文
    const refTargets = new Map()
    // ref -> { body, clipboardText } 提交时经 codec 序列化
    const refCodecs = new Map()

    // 页面内反馈 toast（点击 chip 时显示结果）
    const toastStore = {
      text: '',
      pos: null, // { left, top }
      ok: false,
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        this.listeners.forEach((fn) => fn())
      },
      show(text, pos, ok) {
        this.text = text
        this.pos = pos
        this.ok = !!ok
        this.emit()
      },
      hide() {
        if (!this.text) return
        this.text = ''
        this.pos = null
        this.emit()
      },
    }

    function useToast() {
      const [, force] = React.useState(0)
      React.useEffect(() => toastStore.subscribe(() => force((v) => v + 1)), [])
      return toastStore
    }

    // ============ 选区浮动小气泡 store ============
    const selectionStore = {
      visible: false,
      text: '',
      rect: null,
      anchorKey: null,
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        this.listeners.forEach((fn) => fn())
      },
      show(info) {
        this.visible = true
        this.text = info.text
        this.rect = info.rect
        this.anchorKey = info.anchorKey || null
        this.emit()
      },
      hide() {
        if (!this.visible) return
        this.visible = false
        this.emit()
      },
    }

    function useSelection() {
      const [, force] = React.useState(0)
      React.useEffect(() => selectionStore.subscribe(() => force((v) => v + 1)), [])
      return selectionStore
    }

    // ============ 悬浮批注编辑框 store（单条，锚定在对应文字附近） ============
    const editorStore = {
      item: null, // { sessionId, label, text, anchorKey }
      rect: null,
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        this.listeners.forEach((fn) => fn())
      },
      open(item, rect) {
        this.item = item
        this.rect = rect
        this.emit()
      },
      close() {
        if (!this.item) return
        this.item = null
        this.rect = null
        this.emit()
      },
    }

    function useEditor() {
      const [, force] = React.useState(0)
      React.useEffect(() => editorStore.subscribe(() => force((v) => v + 1)), [])
      return editorStore
    }

    // ============ 引用悬停提示 store ============
    const tooltipStore = {
      visible: false,
      text: '',
      label: '',
      rect: null,
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        this.listeners.forEach((fn) => fn())
      },
      show(info) {
        this.visible = true
        this.text = info.text
        this.label = info.label
        this.rect = info.rect
        this.emit()
      },
      hide() {
        if (!this.visible) return
        this.visible = false
        this.emit()
      },
    }

    function useTooltip() {
      const [, force] = React.useState(0)
      React.useEffect(() => tooltipStore.subscribe(() => force((v) => v + 1)), [])
      return tooltipStore
    }

    // ============ 样式注入（静态包环境：直接操作 document） ============
    function insertStyleSheet(css) {
      const tag = document.createElement('style')
      tag.textContent = css
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    // ============ 文本工具 ============
    function textBlocksToText(blocks, kindField, typeValue) {
      const parts = []
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b && b[kindField] === typeValue && typeof b.text === 'string' && b.text.trim() !== '') {
            parts.push(b.text.trim())
          }
        }
      }
      return parts.join('\n\n')
    }

    function clipText(text, max) {
      if (text.length <= max) return text
      return text.slice(0, max) + '\n…（已截断）'
    }

    const MAX_QUOTE = 1500
    const MAX_SELECTION = 2000

    // 从快照中提取某一轮的用户提问文本与最终 AI 回答文本
    function extractTurnTexts(snapshot, turnLoc) {
      try {
        const turn = turnLoc.turn
        const endSeq = turnLoc.end ? turnLoc.end.seq : Number.POSITIVE_INFINITY
        let prevEnd = 0
        if (snapshot.turnEnds) {
          snapshot.turnEnds.forEach((seq, t) => {
            if (typeof t === 'number' && t < turn && seq > prevEnd) prevEnd = seq
          })
        }
        const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : []
        const userParts = []
        let assistantText = ''
        let assistantSeq = -1
        for (const n of nodes) {
          if (!n || typeof n.seq !== 'number') continue
          if (n.seq <= prevEnd || n.seq > endSeq) continue
          if (n.kind === 'user' || n.kind === 'steering') {
            const text = textBlocksToText(n.content, 'type', 'text')
            if (text !== '') userParts.push(text)
          } else if (n.kind === 'assistant' && n.turn === turn && n.seq > assistantSeq) {
            assistantSeq = n.seq
            const text = textBlocksToText(n.blocks, 'kind', 'text')
            if (text !== '') assistantText = text
          }
        }
        return { userText: userParts.join('\n\n'), assistantText }
      } catch (e) {
        // 快照结构异常时不能抛错：否则整个 turnTail 条目崩溃、按钮消失（表现为"插件突然失效"）
        console.warn('[quote] extractTurnTexts 解析失败', e)
        return { userText: '', assistantText: '' }
      }
    }

    // 解析某一轮里指定类型消息行的 DOM 锚点 key（data-chat-anchor-key）
    function anchorKeyFor(snapshot, turn, kind, closingSeq) {
      try {
        if (!snapshot || !snapshot.chat || !snapshot.chat.locations || !snapshot.chat.nodes) return null
        const keys = snapshot.chat.locations.getTurn(turn) || []
        const nodes = snapshot.chat.nodes
        let fallback = null
        for (const key of keys) {
          const node = nodes.get(key)
          if (!node || node.kind !== kind) continue
          fallback = key
          if (kind === 'user') return key
          if (kind === 'assistant' && typeof closingSeq === 'number' && node.anchorSeq === closingSeq) return key
        }
        return fallback
      } catch (e) {
        return null
      }
    }

    // 按 occurrenceId 解析引用（chip 点击跳转 / 悬停提示共用）
    function resolveOccurrence(occId) {
      try {
        const conversation = rootCtx ? rootCtx.get('conversation') : undefined
        const sessions = rootCtx ? rootCtx.get('sessions') : undefined
        if (!conversation || !conversation.input || !sessions) return null
        const trySession = (sessionId) => {
          if (!sessionId) return null
          const binding = sessions.binding(sessionId)
          if (!binding) return null
          const input = conversation.input.for(binding.ctx)
          const occurrences = input.state.getSnapshot().occurrences || []
          return occurrences.find((o) => o.occurrenceId === occId) || null
        }
        let occ = trySession(currentSessionId)
        if (!occ) {
          for (const refKey of refTargets.keys()) {
            const info = refTargets.get(refKey)
            if (!info || !info.sessionId) continue
            occ = trySession(info.sessionId)
            if (occ) break
          }
        }
        if (!occ || occ.source !== 'quote-ref') return null
        return { occ, info: refTargets.get(occ.ref) }
      } catch (e) {
        return null
      }
    }

    // ============ 链条目选择器：仅在已结束且无交付文件的回合挂载 ============
    function selectTurnQuote(owner) {
      try {
        if (!owner || !owner.turn || !owner.turn.end) return null
        const delivered = owner.turn.data ? owner.turn.data.get('deliverables') : undefined
        if (delivered && Array.isArray(delivered.produced) && delivered.produced.length > 0) return null
        return { turn: owner.turn.turn }
      } catch (e) {
        console.warn('[quote] selectTurnQuote 判定失败', e)
        return null
      }
    }

    function rectOf(e) {
      try {
        const el = e.currentTarget
        if (!el || !el.isConnected) return null
        const r = el.getBoundingClientRect()
        if (!r || (r.width === 0 && r.height === 0)) return null
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      } catch (err) {
        return null
      }
    }

    // 锚点矩形不可用（节点已脱离 DOM / 零尺寸）时的兜底位置：视口下部居中、输入框上方
    function fallbackRect() {
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      const vh = typeof window !== 'undefined' ? window.innerHeight : 768
      return { left: vw * 0.2, top: vh - 340, right: vw * 0.8, bottom: vh - 320 }
    }

    // ============ 组件一：回合尾部的引用按钮（点击直接打开悬浮编辑框） ============
    const TurnQuoteActions = (props) => {
      const snapshot = props.useSession((s) => s)
      // 回合按钮所在会话一定有效：同步 currentSessionId，保证切换会话后锚点跳转仍能定位
      if (typeof props.sessionId === 'string' && props.sessionId !== '') currentSessionId = props.sessionId
      const texts = React.useMemo(() => extractTurnTexts(snapshot, props.turn), [snapshot, props.turn])
      const open = (e, role, label, text) => {
        const anchorKey = anchorKeyFor(snapshot, props.turn.turn, role, props.seq)
        const rect = rectOf(e) || fallbackRect()
        editorStore.open({ sessionId: props.sessionId, label, text, anchorKey }, rect)
      }
      const buttons = []
      if (texts.userText) {
        buttons.push(React.createElement('button', {
          key: 'user',
          type: 'button',
          className: 'dshq-btn',
          onClick: (e) => open(e, 'user', '引用提问 · 第 ' + (props.turn.turn + 1) + ' 轮', clipText(texts.userText, MAX_QUOTE)),
        }, '引用提问'))
      }
      if (texts.assistantText) {
        buttons.push(React.createElement('button', {
          key: 'assistant',
          type: 'button',
          className: 'dshq-btn',
          onClick: (e) => open(e, 'assistant', '引用回答 · 第 ' + (props.turn.turn + 1) + ' 轮', clipText(texts.assistantText, MAX_QUOTE)),
        }, '引用回答'))
      }
      if (buttons.length === 0) return null
      return React.createElement('div', { className: 'dshq-tail' }, buttons)
    }

    // ============ 组件二：鼠标选区浮动小气泡（点击「批注」打开悬浮编辑框） ============
    const SelectionToolbar = (props) => {
      const sel = useSelection()
      const current = typeof props.useSessions === 'function' ? props.useSessions((s) => s.current) : undefined
      if (current !== undefined) currentSessionId = current
      if (!sel.visible || !sel.rect) return null
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      // 气泡宽度随文字增长：估算 = 每字约13px + 按钮与留白约76px，封顶384px
      const est = Math.min(384, Math.max(120, sel.text.length * 13 + 76))
      const center = sel.rect.left + (sel.rect.right - sel.rect.left) / 2
      const left = Math.max(12, Math.min(center - est / 2, vw - est - 12))
      const top = sel.rect.top - 42 >= 8 ? sel.rect.top - 42 : Math.min(sel.rect.bottom + 8, vh - 42)
      const finish = () => {
        try {
          const s = window.getSelection()
          if (s && s.removeAllRanges) s.removeAllRanges()
        } catch (e) { /* ignore */ }
        selectionStore.hide()
      }
      const stage = () => {
        if (current) {
          editorStore.open({ sessionId: current, label: '选中文字', text: clipText(sel.text, MAX_SELECTION), anchorKey: sel.anchorKey }, sel.rect)
        } else {
          // 会话未就绪/切换瞬间 current 为空：给出可见诊断，而不是静默无反应
          console.warn('[quote] 批注未生效：当前会话不可用（sessions 未就绪或正在切换）')
          toastStore.show('批注未生效：当前会话不可用', { left: 24, top: 24 }, false)
        }
        finish()
      }
      return React.createElement('div', { className: 'dshq-toolbar', style: { left, top } },
        React.createElement('span', { className: 'dshq-toolbar-preview' }, sel.text),
        React.createElement('button', {
          type: 'button',
          className: 'dshq-btn dshq-primary dshq-bubble-cta',
          onMouseDown: (e) => e.preventDefault(),
          onClick: stage,
        }, '批注'),
        React.createElement('button', {
          type: 'button',
          className: 'dshq-btn dshq-close',
          onMouseDown: (e) => e.preventDefault(),
          onClick: finish,
        }, '✕'),
      )
    }

    // ============ 组件三：悬浮批注编辑框（评论输入框元素永久驻留，复用时输入法上下文不重建） ============
    const AnnotationEditor = () => {
      const state = useEditor()
      const inputRef = React.useRef(null)
      const [comment, setComment] = React.useState('')
      const [status, setStatus] = React.useState(null)
      React.useEffect(() => {
        setComment('')
        setStatus(null)
        if (state.item && inputRef.current) {
          // 同一元素重复聚焦：输入法记住的语言模式得以保留
          inputRef.current.focus()
        }
      }, [state.item])
      const open = !!(state.item && state.rect)
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      const vh = typeof window !== 'undefined' ? window.innerHeight : 768
      const item = state.item
      let left = -9999
      let top = -9999
      let w = 200
      if (open) {
        // 宽度：默认约 10 字（120px），随评论输入变宽，封顶 340px
        const quoteW = Math.min(220, item.text.length * 12 + 16)
        const inputW = Math.min(300, Math.max(140, comment.length * 13 + 44))
        w = Math.max(120, Math.min(340, Math.max(quoteW, inputW)))
        const r = state.rect
        // 锚点矩形异常（脱离 DOM / 零尺寸）时使用兜底位置，避免编辑器落在视口左上角盖住侧边栏
        const degenerate = !r || typeof r.left !== 'number' || typeof r.top !== 'number' || (r.right - r.left <= 0 && r.bottom - r.top <= 0)
        const anchor = degenerate ? fallbackRect() : r
        const center = anchor.left + (anchor.right - anchor.left) / 2
        left = Math.max(12, Math.min(center - w / 2, vw - w - 12))
        const estH = 236
        // 优先锚点下方；放不下则上方；都不行则固定到视口下部（输入框上方）
        if (anchor.bottom + 8 + estH <= vh - 8) {
          top = anchor.bottom + 8
        } else if (anchor.top - estH - 8 >= 8) {
          top = anchor.top - estH - 8
        } else {
          top = Math.max(8, vh - estH - 8 - 56)
        }
      }
      const insert = () => {
        if (!open || !item) return
        try {
          const c = (comment || '').trim()
          const quoteBody = item.text.split('\n').map((line) => '> ' + line).join('\n')
          const conversation = rootCtx ? rootCtx.get('conversation') : undefined
          const sessions = rootCtx ? rootCtx.get('sessions') : undefined
          const inputTriggers = rootCtx ? rootCtx.get('inputTriggers') : undefined
          if (!conversation || !conversation.input || !sessions) {
            setStatus({ ok: false, text: '写入输入框失败：conversation/sessions 服务不可用' })
            return
          }
          const binding = sessions.binding(item.sessionId)
          if (!binding) {
            setStatus({ ok: false, text: '写入输入框失败：会话不可用' })
            return
          }
          const input = conversation.input.for(binding.ctx)
          const st = input.state.getSnapshot()
          const base = (st.draft || '').replace(/[\s\u00A0]+$/, '')
          const commentTail = c === '' ? '' : '\n\n' + c
          if (inputTriggers && typeof input.insertReference === 'function') {
            const ref = 'q' + (++refSeq)
            refTargets.set(ref, { sessionId: item.sessionId, anchorKey: item.anchorKey || null, body: quoteBody, label: '引用#' + refSeq + (item.label ? ' · ' + item.label : '') })
            refCodecs.set(ref, { body: quoteBody, clipboardText: quoteBody })
            if (refCodecs.size > 200) {
              const oldest = refCodecs.keys().next().value
              refCodecs.delete(oldest)
              refTargets.delete(oldest)
            }
            // 单步插入：在草稿末尾插入引用 chip（机器自动追加占位符+空格）
            const span = { start: st.draft.length, end: st.draft.length, draftRev: st.draftRev }
            const applied = input.insertReference({ source: 'quote-ref', ref, label: '引用#' + refSeq, clipboardText: quoteBody }, span)
            if (applied) {
              // 把评论追加到 chip 之后
              if (commentTail !== '') {
                const st3 = input.state.getSnapshot()
                input.setDraft(st3.draft.replace(/[ \t]+$/, '') + commentTail)
              }
              const anchorNote = item.anchorKey ? '定位键：' + item.anchorKey : '未定位到消息行，点击锚点可能无法跳转'
              setStatus({ ok: true, text: '已插入引用锚点 ✓（' + anchorNote + '）' })
              console.log('[quote] 引用锚点已插入', { ref, applied, anchorKey: item.anchorKey })
              editorStore.close()
              return
            }
            // 未生效：回退纯文本
            refTargets.delete(ref)
            refCodecs.delete(ref)
            input.setDraft(base === '' ? quoteBody + commentTail : base + '\n\n' + quoteBody + commentTail)
            setStatus({ ok: false, text: '锚点插入未生效，已回退为纯文本引用（管线异常）' })
          } else {
            // 无引用管线时回退为纯文本插入
            input.setDraft(base === '' ? quoteBody + commentTail : base + '\n\n' + quoteBody + commentTail)
            setStatus({ ok: false, text: '引用管线不可用，已插入纯文本引用' })
          }
          editorStore.close()
        } catch (e) {
          setStatus({ ok: false, text: '插入失败：' + (e && e.message ? e.message : String(e)) })
          console.error('[quote] 插入失败', e)
        }
      }
      const hint = pipelineAvailable === false ? '引用锚点管线不可用，将插入纯文本引用' : '插入后将生成引用锚点，点击输入框里的锚点可跳回原文'
      return React.createElement('div', {
        className: open ? 'dshq-editor' : 'dshq-editor dshq-editor-hidden',
        style: { left, top, width: w },
      },
        React.createElement('div', { className: 'dshq-editor-label' }, open ? item.label : ''),
        React.createElement('div', { className: 'dshq-editor-quote' }, open ? item.text : ''),
        React.createElement('input', {
          ref: inputRef,
          className: 'dshq-editor-input',
          value: comment,
          placeholder: '输入评论…',
          onChange: (e) => setComment(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter') insert()
            if (e.key === 'Escape') editorStore.close()
          },
        }),
        status && open ? React.createElement('div', { className: status.ok ? 'dshq-editor-status dshq-ok' : 'dshq-editor-status dshq-err' }, status.text) : (open ? React.createElement('div', { className: 'dshq-editor-hint' }, hint) : null),
        React.createElement('div', { className: 'dshq-editor-actions' },
          React.createElement('button', { type: 'button', className: 'dshq-btn dshq-primary', onClick: insert }, '插入输入框'),
          React.createElement('button', { type: 'button', className: 'dshq-btn', onClick: () => editorStore.close() }, '✕'),
        ),
      )
    }

    // ============ 组件四：引用悬停提示（显示当时选中的文字） ============
    const QuoteTooltip = () => {
      const t = useTooltip()
      if (!t.visible || !t.rect) return null
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      const vh = typeof window !== 'undefined' ? window.innerHeight : 768
      const w = Math.min(340, Math.max(180, Math.min(t.text.length, 60) * 11 + 48))
      const estH = Math.min(200, 56 + Math.ceil(Math.min(t.text.length, 400) / 22) * 15)
      const center = t.rect.left + (t.rect.right - t.rect.left) / 2
      const left = Math.max(8, Math.min(center - w / 2, vw - w - 8))
      let top = t.rect.top - estH - 8
      if (top < 8) top = Math.min(vh - estH - 8, t.rect.bottom + 8)
      return React.createElement('div', { className: 'dshq-tip', style: { left, top, width: w } },
        React.createElement('div', { className: 'dshq-tip-label' }, t.label),
        React.createElement('div', { className: 'dshq-tip-quote' }, t.text),
      )
    }

    // ============ 组件五：点击 chip 的反馈 toast（shell.overlay 条目） ============
    const FeedbackToast = () => {
      const t = useToast()
      if (!t.text || !t.pos) return null
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      const left = Math.max(12, Math.min(t.pos.left - 80, vw - 180))
      return React.createElement('div', {
        className: t.ok ? 'dshq-toast dshq-toast-ok' : 'dshq-toast dshq-toast-err',
        style: { left, top: t.pos.top + 18 },
      }, t.text)
    }

    // ============ 样式（主题令牌自适应明暗） ============
    const css = `
.dshq-tail{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap;margin-left:2px}
.dshq-btn{appearance:none;background:transparent;border:1px solid transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1.4;padding:2px 8px;border-radius:6px;cursor:pointer;transition:background .12s ease,color .12s ease}
.dshq-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dshq-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.dshq-primary:hover{background:var(--dsw-alias-brand-primary);color:#fff;opacity:.9}
.dshq-toolbar{position:fixed;display:flex;align-items:center;gap:4px;min-width:10em;width:max-content;max-width:min(32em,calc(100vw - 24px));font-size:12px;padding:3px 7px;border-radius:999px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 4px 14px rgba(0,0,0,.14);pointer-events:auto;box-sizing:border-box;z-index:2147483000}
.dshq-toolbar-preview{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshq-bubble-cta{flex:none;padding:1px 8px;border-radius:999px}
.dshq-close{flex:none;padding:1px 5px;opacity:.7}
.dshq-editor{position:fixed;display:flex;flex-direction:column;gap:5px;box-sizing:border-box;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 8px 24px rgba(0,0,0,.18);pointer-events:auto;font-size:12px;z-index:2147483000}
.dshq-editor-hidden{opacity:0;pointer-events:none}
.dshq-editor-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshq-editor-quote{margin:0;padding:3px 8px;border-left:3px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;max-height:96px;overflow:auto}
.dshq-editor-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:4px 8px}
.dshq-editor-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dshq-editor-hint{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.8}
.dshq-editor-status{font-size:11px;line-height:1.5}
.dshq-editor-status.dshq-ok{color:var(--dsw-alias-state-success-primary)}
.dshq-editor-status.dshq-err{color:var(--dsw-alias-state-error-primary)}
.dshq-editor-actions{display:flex;justify-content:flex-end;gap:6px}
.dshq-tip{position:fixed;display:flex;flex-direction:column;gap:4px;box-sizing:border-box;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 6px 18px rgba(0,0,0,.18);pointer-events:none;z-index:2147483000;font-size:12px}
.dshq-tip-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshq-tip-quote{margin:0;padding:3px 8px;border-left:3px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto;font-size:11px}
.dshq-flash{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:4px;border-radius:8px}
.dshq-toast{position:fixed;max-width:240px;padding:5px 9px;border-radius:8px;font-size:11px;line-height:1.5;box-shadow:0 4px 14px rgba(0,0,0,.18);pointer-events:none;z-index:2147483000}
.dshq-toast-ok{background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-primary)}
.dshq-toast-err{background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
/* 根因：textarea（透明文字、absolute、inset:0）渲染在 backdrop 之后，整层盖住 chip。
   给 chip 提升 z-index 使其浮到 textarea 之上，点击才能落到 chip 上。 */
[data-occurrence]{pointer-events:auto;cursor:pointer;position:relative;z-index:1}
`

    // ============ 插件主体 ============
    function apply(ctx) {
      rootCtx = ctx
      const slots = ctx.get('slots')
      if (slots === undefined) return
      ctx.effect(() => insertStyleSheet(css), 'dsh-quote-annotate: styles')
      // 注册引用 source（提交时把占位符序列化为引用正文；空候选分组不渲染，不污染 @ 菜单）
      const inputTriggers = ctx.get('inputTriggers')
      pipelineAvailable = !!(inputTriggers && typeof inputTriggers.registerSource === 'function')
      if (pipelineAvailable) {
        ctx.effect(() => {
          // registerSource 对重复 (trigger,name) 会 throw；插件热重载/重复 apply 时可能已注册，
          // 这里兜住异常，避免 apply 中断导致全局监听与槽位注册全部丢失（插件整体失效）
          try {
            inputTriggers.registerSource({
              trigger: '@',
              name: 'quote-ref',
              order: 100,
              candidates: async () => [],
              onPick: () => undefined,
              codec: {
                clipboardText: (ref) => (refCodecs.get(ref) ? refCodecs.get(ref).clipboardText : ''),
                serialize: (ref) => Promise.resolve(refCodecs.get(ref) ? refCodecs.get(ref).body : ''),
              },
            })
            console.log('[quote] 引用锚点管线已注册')
          } catch (err) {
            console.warn('[quote] 引用锚点管线注册跳过（可能已注册）：', err && err.message ? err.message : err)
          }
        }, 'dsh-quote-annotate: quote-ref source')
      } else {
        console.warn('[quote] inputTriggers 服务不可用，引用锚点功能将退化为纯文本')
      }
      // 全局监听（选区气泡 / chip 点击跳转 / chip 悬停提示；ctx.effect 保证卸载时全部清理）
      ctx.effect(() => {
        let raf = 0
        let toastTimer = null
        let hideTimer = null
        const onKey = (e) => {
          if (e.key === 'Escape') {
            editorStore.close()
            selectionStore.hide()
            toastStore.hide()
            tooltipStore.hide()
          }
        }
        const showToast = (text, pos, ok) => {
          toastStore.show(text, pos, ok)
          if (toastTimer) clearTimeout(toastTimer)
          toastTimer = setTimeout(() => toastStore.hide(), 2600)
        }
        const cancelHide = () => {
          if (hideTimer) {
            clearTimeout(hideTimer)
            hideTimer = null
          }
        }
        const scheduleHide = () => {
          if (hideTimer) return
          hideTimer = setTimeout(() => {
            hideTimer = null
            selectionStore.hide()
          }, 150)
        }
        const onScroll = () => {
          schedule()
          tooltipStore.hide()
        }
        // 用 pointerdown 捕获（比 click 更早，且不受 click 阶段任何 stopPropagation 影响）
        const onChipPress = (e) => {
          try {
            tooltipStore.hide()
            const el = e.target && e.target.closest ? e.target.closest('[data-occurrence]') : null
            const pos = { left: e.clientX, top: e.clientY }
            if (!el) return
            const occId = Number(el.getAttribute('data-occurrence'))
            if (!Number.isFinite(occId)) return
            const found = resolveOccurrence(occId)
            if (!found || !found.info) {
              showToast('跳转失败：找不到该引用（可能已发送或被删除）', pos, false)
              return
            }
            let anchorKey = found.info.anchorKey
            // 兜底：按引用正文内容反查原文行
            if (!anchorKey && found.info.body) {
              const probe = (found.info.body || '').replace(/^> /, '').slice(0, 24)
              const rows = document.querySelectorAll('[data-chat-anchor-key]')
              for (const r of rows) {
                if (probe && r.textContent && r.textContent.indexOf(probe) !== -1) {
                  anchorKey = r.getAttribute('data-chat-anchor-key')
                  break
                }
              }
            }
            if (!anchorKey) {
              showToast('跳转失败：没有定位键（选中时未识别到消息行）', pos, false)
              return
            }
            const rows = document.querySelectorAll('[data-chat-anchor-key]')
            let row = null
            for (const r of rows) {
              if (r.getAttribute('data-chat-anchor-key') === anchorKey) {
                row = r
                break
              }
            }
            if (!row) {
              showToast('跳转失败：原文行不在当前页面（可能已切换会话）', pos, false)
              return
            }
            row.scrollIntoView({ block: 'center', behavior: 'smooth' })
            row.classList.add('dshq-flash')
            setTimeout(() => row.classList.remove('dshq-flash'), 1600)
            showToast('已跳转到原文 ✓', pos, true)
            console.log('[quote] 已跳转到原文', anchorKey)
          } catch (err) {
            showToast('跳转出错：' + (err && err.message ? err.message : String(err)), { left: e.clientX, top: e.clientY }, false)
            console.error('[quote] 点击跳转出错', err)
          }
        }
        // 悬停 chip：显示当时选中的文字
        const onChipOver = (e) => {
          try {
            const el = e.target && e.target.closest ? e.target.closest('[data-occurrence]') : null
            if (!el) {
              tooltipStore.hide()
              return
            }
            const occId = Number(el.getAttribute('data-occurrence'))
            if (!Number.isFinite(occId)) {
              tooltipStore.hide()
              return
            }
            const found = resolveOccurrence(occId)
            if (!found || !found.info || !found.info.body) {
              tooltipStore.hide()
              return
            }
            const r = el.getBoundingClientRect()
            tooltipStore.show({
              text: (found.info.body || '').replace(/^> /gm, '').trim(),
              label: found.info.label || '引用',
              rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
            })
          } catch (err) { /* ignore */ }
        }
        const onChipOut = (e) => {
          try {
            const el = e.target && e.target.closest ? e.target.closest('[data-occurrence]') : null
            if (!el) return
            const next = e.relatedTarget
            if (next && next.closest && next.closest('[data-occurrence]')) return
            tooltipStore.hide()
          } catch (err) { /* ignore */ }
        }
        const compute = () => {
          raf = 0
          try {
            const sel = window.getSelection()
            if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
              // 选区消失：延迟隐藏，避免流式渲染抖动导致气泡闪没
              scheduleHide()
              return
            }
            const text = (sel.toString() || '').trim()
            if (!text) {
              scheduleHide()
              return
            }
            const range = sel.getRangeAt(0)
            const node = range.commonAncestorContainer
            const host = node && node.nodeType === 1 ? node : (node ? node.parentElement : null)
            if (host && host.closest('textarea, input, [contenteditable="true"]')) {
              scheduleHide()
              return
            }
            const rect = range.getBoundingClientRect()
            if (!rect || (rect.width === 0 && rect.height === 0)) {
              scheduleHide()
              return
            }
            // 选区滚出视口（自动滚动场景）才隐藏；仍在视口内则跟随重定位
            const vh = typeof window !== 'undefined' ? window.innerHeight : 768
            if (rect.bottom < -8 || rect.top > vh + 8) {
              scheduleHide()
              return
            }
            cancelHide()
            const anchor = sel.anchorNode && sel.anchorNode.nodeType === 1 ? sel.anchorNode : (sel.anchorNode ? sel.anchorNode.parentElement : null)
            let anchorKey = null
            if (anchor) {
              const row = anchor.closest('[data-chat-anchor-key]')
              if (row) anchorKey = row.getAttribute('data-chat-anchor-key')
            }
            selectionStore.show({
              text: clipText(text, MAX_SELECTION),
              rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
              anchorKey,
            })
          } catch (e) {
            scheduleHide()
          }
        }
        const schedule = () => {
          if (!raf) raf = requestAnimationFrame(compute)
        }
        document.addEventListener('selectionchange', schedule)
        // 滚动/缩放不再盲目隐藏：重新计算选区位置，跟随重定位（执行任务自动滚动时气泡不消失）
        document.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onScroll)
        document.addEventListener('keydown', onKey)
        document.addEventListener('pointerdown', onChipPress, true)
        document.addEventListener('pointerover', onChipOver, true)
        document.addEventListener('pointerout', onChipOut, true)
        return () => {
          document.removeEventListener('selectionchange', schedule)
          document.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onScroll)
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('pointerdown', onChipPress, true)
          document.removeEventListener('pointerover', onChipOver, true)
          document.removeEventListener('pointerout', onChipOut, true)
          if (raf) cancelAnimationFrame(raf)
          if (hideTimer) clearTimeout(hideTimer)
          if (toastTimer) clearTimeout(toastTimer)
        }
      }, 'dsh-quote-annotate: global listeners')
      slots.inject('conversation.chat.turnTail', () => slots.register(
        { name: 'conversation.chat.turnTail', select: selectTurnQuote, priority: 10 },
        TurnQuoteActions,
      ))
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'quote-selection-toolbar', order: 100 },
        SelectionToolbar,
      ))
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'quote-annotation-editor', order: 101 },
        AnnotationEditor,
      ))
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'quote-tooltip', order: 103 },
        QuoteTooltip,
      ))
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'quote-feedback-toast', order: 102 },
        FeedbackToast,
      ))
    }

    exports.apply = apply
    return module.exports
  },
})
