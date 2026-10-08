'use client'

// A command in a code block with a copy button. `prompt` shows a "$ " that isn't copied.
import { useEffect, useRef, useState } from 'react'

export default function CopyCode ({ text, className = 'cmd-example', prompt = true }) {
  const [state, setState] = useState('') // '', 'copied' or 'failed'
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setState('copied')
    } catch {
      setState('failed')
    }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState(''), 1600)
  }

  const label = state === 'copied' ? 'Copied' : state === 'failed' ? "Couldn't copy" : 'Copy'
  return (
    <div className={`code-copy ${className}-wrap`}>
      <pre className={className}><code>{prompt && <span aria-hidden='true'>$ </span>}{text}</code></pre>
      <button type='button' className={`code-copy-btn${state ? ' ' + state : ''}`} onClick={copy} aria-label={state ? label : `Copy: ${text}`} title={label}>
        <svg viewBox='0 0 24 24' aria-hidden='true'>
          {state === 'copied'
            ? <path d='M5 12.5l4.5 4.5L19 7.5' />
            : <><rect x='8' y='8' width='12' height='12' rx='2.5' /><path d='M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8' /></>}
        </svg>
        <span className='code-copy-label' aria-live='polite'>{state ? label : ''}</span>
      </button>
    </div>
  )
}
