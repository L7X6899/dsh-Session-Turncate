/**
 * dsh-Session-Turncate — client half.
 *
 * Registers one Conversation target view ("上下文截断") next to 对话 / 轨迹 /
 * 上下文 and talks to the host half over a same-origin HTTP endpoint.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-turncate',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require('react');
    const h = react.createElement;

    const name = 'session-turncate';
    const inject = ['slots'];

    const API = '/session-turncate/api';
    const MIN_HOURS = 0;
    const MAX_HOURS = 24;

    const C = {
      text: 'var(--dsw-alias-label-primary, currentColor)',
      muted: 'var(--dsw-alias-label-secondary, rgba(128,128,128,0.9))',
      faint: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.75))',
      border: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.28))',
      layer: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.14))',
      brand: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      error: 'var(--dsw-alias-state-error-primary, #d94a4a)',
    };

    function clampHours(value) {
      const hours = Number(value);
      if (!Number.isFinite(hours)) return null;
      if (hours < MIN_HOURS) return MIN_HOURS;
      if (hours > MAX_HOURS) return MAX_HOURS;
      return Math.round(hours * 100) / 100;
    }

    function formatTime(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '暂无';
      const date = new Date(ms);
      const pad = (value) => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    async function callApi(payload) {
      const response = await fetch(API, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (body === null) return { ok: false, error: `服务返回了无法解析的响应（HTTP ${response.status}）。` };
      return body;
    }

    function card(children) {
      return h('section', {
        style: {
          border: `1px solid ${C.border}`,
          borderRadius: 12,
          background: C.layer,
          padding: '16px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        },
      }, children);
    }

    function sectionTitle(text) {
      return h('div', { style: { fontSize: 15, fontWeight: 600, color: C.text } }, text);
    }

    function hint(text) {
      return h('div', { style: { fontSize: 12.5, lineHeight: 1.6, color: C.muted } }, text);
    }

    function spinButton(label, title, onClick, disabled) {
      return h('button', {
        type: 'button',
        title,
        'aria-label': title,
        disabled: disabled === true,
        onClick,
        style: {
          width: 26,
          height: 17,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 9,
          lineHeight: 1,
          cursor: disabled === true ? 'default' : 'pointer',
          color: C.text,
          background: 'transparent',
          border: `1px solid ${C.border}`,
          borderRadius: 4,
          opacity: disabled === true ? 0.45 : 1,
        },
      }, label);
    }

    function switchControl(on, disabled, onToggle) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'aria-label': '上下文管理',
        disabled: disabled === true,
        onClick: onToggle,
        style: {
          position: 'relative',
          width: 44,
          height: 24,
          borderRadius: 999,
          border: `1px solid ${on ? C.brand : C.border}`,
          background: on ? C.brand : 'transparent',
          cursor: disabled === true ? 'default' : 'pointer',
          padding: 0,
          opacity: disabled === true ? 0.6 : 1,
          transition: 'background 120ms ease, border-color 120ms ease',
        },
      }, h('span', {
        style: {
          position: 'absolute',
          top: 2,
          left: on ? 22 : 2,
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: on ? '#fff' : C.muted,
          transition: 'left 120ms ease',
        },
      }));
    }

    function primaryButton(label, onClick, disabled) {
      return h('button', {
        type: 'button',
        disabled,
        onClick,
        style: {
          padding: '8px 16px',
          borderRadius: 8,
          border: `1px solid ${C.brand}`,
          background: C.brand,
          color: '#fff',
          fontSize: 13,
          fontWeight: 500,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.6 : 1,
        },
      }, label);
    }

    function ghostButton(label, onClick, disabled) {
      return h('button', {
        type: 'button',
        disabled,
        onClick,
        style: {
          padding: '8px 16px',
          borderRadius: 8,
          border: `1px solid ${C.border}`,
          background: 'transparent',
          color: C.text,
          fontSize: 13,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.6 : 1,
        },
      }, label);
    }

    function TruncatePanel(props) {
      const sessionId = props && (props.sessionId || (props.session && props.session.id) || null);
      const [state, setState] = react.useState(null);
      const [hoursDraft, setHoursDraft] = react.useState('');
      const [busy, setBusy] = react.useState(false);
      const [notice, setNotice] = react.useState(null);
      const [failure, setFailure] = react.useState(null);

      const adopt = react.useCallback((next) => {
        setState(next);
        setHoursDraft(String(next && typeof next.hours === 'number' ? next.hours : 4));
      }, []);

      react.useEffect(() => {
        let alive = true;
        if (!sessionId) {
          setState(null);
          return () => { alive = false; };
        }
        setFailure(null);
        callApi({ op: 'status', sessionId }).then((result) => {
          if (!alive) return;
          if (result && result.ok && result.state) adopt(result.state);
          else setFailure((result && result.error) || '读取状态失败。');
        }).catch((error) => {
          if (alive) setFailure(`读取状态失败：${(error && error.message) || error}`);
        });
        return () => { alive = false; };
      }, [sessionId, adopt]);

      const save = react.useCallback(async (patch) => {
        if (!sessionId) return;
        const hours = patch && 'hours' in patch ? patch.hours : clampHours(hoursDraft);
        if (hours === null) {
          setFailure('请输入 0 到 24 之间的小时数。');
          return;
        }
        setBusy(true);
        setFailure(null);
        setNotice(null);
        try {
          const payload = { op: 'set', sessionId, hours };
          if (patch && typeof patch.enabled === 'boolean') payload.enabled = patch.enabled;
          const result = await callApi(payload);
          if (result && result.ok && result.state) {
            adopt(result.state);
            setNotice('已保存。');
          } else {
            setFailure((result && result.error) || '保存失败。');
          }
        } catch (error) {
          setFailure(`保存失败：${(error && error.message) || error}`);
        } finally {
          setBusy(false);
        }
      }, [sessionId, hoursDraft, adopt]);

      const cutNow = react.useCallback(async () => {
        if (!sessionId) return;
        setBusy(true);
        setFailure(null);
        setNotice(null);
        try {
          const result = await callApi({ op: 'cut', sessionId });
          if (result && result.state) adopt(result.state);
          if (result && result.ok) setNotice(result.message || '已截断。');
          else setFailure((result && (result.error || result.message)) || '截断失败。');
        } catch (error) {
          setFailure(`截断失败：${(error && error.message) || error}`);
        } finally {
          setBusy(false);
        }
      }, [sessionId, adopt]);

      const step = react.useCallback((delta) => {
        const current = clampHours(hoursDraft);
        const base = current === null ? 4 : current;
        const next = clampHours(base + delta);
        setHoursDraft(String(next === null ? base : next));
        setNotice(null);
      }, [hoursDraft]);

      const header = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('div', { style: { fontSize: 18, fontWeight: 650, color: C.text } }, '上下文截断'),
        hint('按会话生效。本会话长时间没有输入时，较早的对话会被整段丢弃（不生成摘要），避免上一个任务污染下一个任务。'),
      );

      if (!sessionId) {
        return h('div', { style: { padding: '24px', display: 'flex', flexDirection: 'column', gap: 14 } },
          header,
          hint('请先在左侧选择一个会话。'),
        );
      }

      if (state === null) {
        return h('div', { style: { padding: '24px', display: 'flex', flexDirection: 'column', gap: 14 } },
          header,
          failure
            ? h('div', { style: { color: C.error, fontSize: 13 } }, failure)
            : hint('载入中…'),
        );
      }

      const enabled = state.enabled === true;
      const times = typeof state.cutCount === 'number' ? state.cutCount : 0;

      return h('div', {
        style: { padding: '24px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760, color: C.text },
      },
        header,

        card(
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 } },
            sectionTitle('上下文管理'),
            switchControl(enabled, busy, () => save({ enabled: !enabled })),
          ),
          hint('启用后，当前会话长时间无输入时会话将自动重置，有效降低 token 消耗。'),
        ),

        card(
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 } },
            sectionTitle('自动截断上下文时间'),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('input', {
                type: 'number',
                min: MIN_HOURS,
                max: MAX_HOURS,
                step: 1,
                value: hoursDraft,
                'aria-label': '自动截断上下文时间（小时）',
                disabled: busy,
                onChange: (event) => { setHoursDraft(event.target.value); setNotice(null); },
                onBlur: () => { const next = clampHours(hoursDraft); if (next !== null) setHoursDraft(String(next)); },
                style: {
                  width: 76,
                  padding: '6px 8px',
                  fontSize: 14,
                  textAlign: 'right',
                  color: C.text,
                  background: 'transparent',
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                },
              }),
              h('span', { style: { fontSize: 13, color: C.muted } }, '小时'),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                spinButton('▲', '增加一小时', () => step(1), busy),
                spinButton('▼', '减少一小时', () => step(-1), busy),
              ),
            ),
          ),
          hint('超过设定时间后，将会自动截断上下文记忆。'),
          hint(`单位小时，可填 ${MIN_HOURS}–${MAX_HOURS}；填 0 表示不按时间自动截断。`),
        ),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
          primaryButton('保存', () => save(), busy),
          ghostButton('立即截断', cutNow, busy),
          h('div', { style: { fontSize: 12.5, color: C.faint } },
            `上次截断：${formatTime(state.lastCutMs)}　累计 ${times} 次`),
        ),

        notice ? h('div', { style: { fontSize: 13, color: C.brand } }, notice) : null,
        failure ? h('div', { style: { fontSize: 13, color: C.error } }, failure) : null,
        hint('命令同样可用：/truncate on 4、/truncate off、/truncate now、/truncate status。'),
      );
    }

    function apply(ctx) {
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'truncate',
        order: 40,
        label: '上下文截断',
        inject: (sessionId) => ({ sessionId }),
      }, TruncatePanel));
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});