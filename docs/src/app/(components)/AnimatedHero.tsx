'use client'

import { Fragment, useEffect, useRef, useState } from 'react'
import { Highlight } from 'prism-react-renderer'

// Configuration
const ANIMATION_CONFIG = {
  TYPING_SPEED: 5, // Milliseconds per character
  ANIMATION_START_DELAY: 500, // Delay before starting typing animation
  POST_TYPING_PAUSE: 2000, // How long to pause after typing completes
  AUTO_SWITCH_DELAY: 2000, // Delay before auto-switching to next tab
}

// Types
interface Tab {
  id: string
  name: string
  sessionLabel: string
  command: string
  code: string
}

// UI Components - Terminal-style header
function TerminalHeader({
  tabs,
  activeTab,
  onTabChange,
}: {
  tabs: Tab[]
  activeTab: string
  onTabChange: (id: string) => void
}) {
  return (
    <div className="flex items-center justify-between border-b border-zinc-700/80 bg-zinc-900/90 px-4 py-2">
      <div className="flex items-center gap-3">
        <div className="flex gap-1.5">
          <div className="h-2.5 w-2.5 rounded-full bg-zinc-600" />
          <div className="h-2.5 w-2.5 rounded-full bg-zinc-600" />
          <div className="h-2.5 w-2.5 rounded-full bg-zinc-600" />
        </div>
        <span className="font-mono text-xs text-zinc-500">zsh</span>
        <span className="text-zinc-600">—</span>
        <span className="font-mono text-xs text-[#00ff41]/80">~/project</span>
      </div>
      <div className="flex gap-1 font-mono text-xs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            className={`rounded px-2 py-1 transition ${
              activeTab === tab.id
                ? 'bg-zinc-700/80 text-[#00ff41]'
                : 'text-zinc-500 hover:bg-zinc-800/80 hover:text-zinc-400'
            }`}
          >
            {tab.sessionLabel}
          </button>
        ))}
      </div>
    </div>
  )
}

// Block cursor - matrix green glow
function CursorStyle() {
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
      @keyframes cursor-blink {
        0%, 100% { opacity: 1; }
        50% { opacity: 0; }
      }
      .typing-cursor {
        display: inline-block;
        width: 0.6em;
        height: 1.2em;
        background-color: #00ff41;
        box-shadow: 0 0 8px rgba(0, 255, 65, 0.6);
        margin-left: 2px;
        animation: cursor-blink 1s step-end infinite;
        vertical-align: middle;
      }
    `,
      }}
    />
  )
}

// Console output - command line + code with syntax highlighting
function ConsoleOutput({
  command,
  code,
  showCursor,
}: {
  command: string
  code: string
  showCursor: boolean
}) {
  const hasCommand = command.length > 0
  const hasCode = code.length > 0
  const cursorOnCommand = showCursor && !hasCode

  return (
    <div className="min-h-[200px] bg-zinc-950/50 p-4 font-mono text-sm">
      {/* Command line - $ prompt + command */}
      {(hasCommand || (!hasCommand && showCursor)) && (
        <div className="mb-2">
          <span className="text-[#00ff41]">$</span>{' '}
          <span className="text-cyan-400">{command}</span>
          {cursorOnCommand && <span className="typing-cursor" />}
        </div>
      )}

      {/* Code output (result of cat) - raw file contents, no line numbers */}
      {hasCode && (
        <div className="overflow-x-auto">
          <Highlight code={code} language="tsx" theme={{ plain: {}, styles: [] }}>
            {({ tokens, getTokenProps }) => (
              <pre className="m-0 overflow-x-auto text-zinc-400">
                <code>
                  {tokens.map((line, lineIndex) => (
                    <Fragment key={lineIndex}>
                      {line
                        .filter((token) => !token.empty)
                        .map((token, tokenIndex) => (
                          <span key={tokenIndex} {...getTokenProps({ token })} />
                        ))}
                      {lineIndex === tokens.length - 1 && showCursor && (
                        <span className="typing-cursor" />
                      )}
                      {'\n'}
                    </Fragment>
                  ))}
                </code>
              </pre>
            )}
          </Highlight>
        </div>
      )}
    </div>
  )
}

// Data - console sessions with cat commands
const CODE_TABS: Tab[] = [
  {
    id: 'client',
    name: 'ConversationPage.tsx',
    sessionLabel: 'client',
    command: 'cat src/ConversationPage.tsx',
    code: `import { useConversation } from '@m4trix/react';

export default function ConversationPage() {
  const { startRecording, stopRecording } = useConversation('/api/voice-chat', {
    autoPlay: true,
    onError: (state, error) => {
      console.error('Conversation error:', error);
    }
  });
  
  // ... jsx render ...
}`,
  },
  {
    id: 'server',
    name: 'route.ts',
    sessionLabel: 'server',
    command: 'cat src/app/api/route.ts',
    code: `import { NextRequest } from 'next/server';
import { Pump } from '@m4trix/stream';
import { /*...*/ } from '@/lib';

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const transcript = await transcribeFormData(formData);
  const agentStream = await getAgentResponse(transcript);
  
  return await Pump.from(agentStream)
    .filter(shouldChunkBeStreamed)
    .map(messageToText)
    .bundle(intoChunksOfMinLength(40))
    .map((text) => text.join(""))
    .rechunk(ensureFullWords)
    .rechunk(fixBrokenWords)
    .onClose(handleCompletedAgentResponse)
    .slidingWindow(10, 1)
    .filter(filterOutIrrelevantWindows)
    .buffer(5)
    .map(textToSpeech)
    .sequenceStreams()
    .drainTo(httpStreamResponse());
}`,
  },
]

// Main component
export default function AnimatedHero() {
  // State
  const [visibleCommand, setVisibleCommand] = useState('')
  const [visibleCode, setVisibleCode] = useState('')
  const [showCursor, setShowCursor] = useState(true)
  const [currentTabIndex, setCurrentTabIndex] = useState(0)
  const [fullAnimationCycleComplete, setFullAnimationCycleComplete] =
    useState(false)

  // Refs
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const animationComplete = useRef(false)
  const hasAnimatedOnce = useRef<Record<string, boolean>>({})
  const currentTabIndexRef = useRef(0)

  const tabs = CODE_TABS
  const activeTab = tabs[currentTabIndex].id
  const currentTab = tabs[currentTabIndex]
  currentTabIndexRef.current = currentTabIndex

  // Animation: type command first, then code
  const startTypingAnimation = (tab: Tab, tabId: string) => {
    let phase: 'command' | 'code' = 'command'
    let commandIndex = 0
    let codeIndex = 0
    const typingSpeed = ANIMATION_CONFIG.TYPING_SPEED

    const typeNextChar = () => {
      if (phase === 'command') {
        if (commandIndex <= tab.command.length) {
          setVisibleCommand(tab.command.substring(0, commandIndex))
          commandIndex++
          timerRef.current = setTimeout(typeNextChar, typingSpeed)
        } else {
          phase = 'code'
          setVisibleCode('')
          typeNextChar()
        }
      } else {
        if (codeIndex <= tab.code.length) {
          setVisibleCode(tab.code.substring(0, codeIndex))
          codeIndex++
          timerRef.current = setTimeout(typeNextChar, typingSpeed)
        } else {
          hasAnimatedOnce.current[tabId] = true

          setTimeout(() => {
            setShowCursor(false)
            animationComplete.current = true

            if (Object.keys(hasAnimatedOnce.current).length === tabs.length) {
              setFullAnimationCycleComplete(true)
            }

            const idx = currentTabIndexRef.current
            if (idx < tabs.length - 1) {
              timerRef.current = setTimeout(() => {
                handleTabChange(tabs[idx + 1].id)
              }, ANIMATION_CONFIG.AUTO_SWITCH_DELAY)
            }
          }, ANIMATION_CONFIG.POST_TYPING_PAUSE)
        }
      }
    }

    timerRef.current = setTimeout(
      typeNextChar,
      ANIMATION_CONFIG.ANIMATION_START_DELAY,
    )
  }

  const handleTabChange = (id: string) => {
    const newIndex = tabs.findIndex((tab) => tab.id === id)
    if (newIndex !== currentTabIndex) {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }

      if (fullAnimationCycleComplete || hasAnimatedOnce.current[id]) {
        setCurrentTabIndex(newIndex)
        const tab = tabs[newIndex]
        setVisibleCommand(tab.command)
        setVisibleCode(tab.code)
        setShowCursor(false)
        return
      }

      if (animationComplete.current) {
        setCurrentTabIndex(newIndex)
        setVisibleCommand('')
        setVisibleCode('')
        setShowCursor(true)
        animationComplete.current = false
        startTypingAnimation(tabs[newIndex], id)
      }
    }
  }

  useEffect(() => {
    startTypingAnimation(tabs[0], tabs[0].id)
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [])

  return (
    <div className="mx-auto mt-16 max-w-7xl px-6 lg:px-8">
      <div className="relative overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900/90 shadow-xl shadow-black/20 ring-1 ring-[#00ff41]/10">
        <div className="absolute -inset-px rounded-xl bg-gradient-to-b from-[#00ff41]/5 to-transparent opacity-50" />
        <TerminalHeader
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={handleTabChange}
        />
        <CursorStyle />
        <ConsoleOutput
          command={visibleCommand}
          code={visibleCode}
          showCursor={showCursor}
        />
      </div>
    </div>
  )
}
