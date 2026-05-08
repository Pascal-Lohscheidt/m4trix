'use client'

import { useEffect, useRef } from 'react'

const MATRIX_CHARS =
  'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEFabcdef{}[]<>/:;.=+-*&@#'

interface MatrixRainProps {
  className?: string
  opacity?: number
  color?: string
  fontSize?: number
  speed?: number
}

export default function MatrixRain({
  className = '',
  opacity = 0.04,
  color = '#00ff41',
  fontSize = 14,
  speed = 33,
}: MatrixRainProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let columns: number[] = []
    let interval: ReturnType<typeof setInterval> | null = null

    const resize = () => {
      const w = canvas.offsetWidth || window.innerWidth
      const h = canvas.offsetHeight || window.innerHeight
      if (w === 0 || h === 0) return

      canvas.width = w
      canvas.height = h
      const colCount = Math.floor(w / fontSize)
      columns = Array.from(
        { length: colCount },
        () => (Math.random() * h) / fontSize,
      )
    }

    const draw = () => {
      // Fade effect
      ctx.fillStyle = `rgba(9, 9, 11, 0.05)`
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      ctx.fillStyle = color
      ctx.font = `${fontSize}px monospace`

      for (let i = 0; i < columns.length; i++) {
        const char =
          MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)]
        const x = i * fontSize
        const y = columns[i] * fontSize

        // Vary brightness
        const brightness = Math.random()
        if (brightness > 0.95) {
          ctx.fillStyle = '#ffffff'
        } else if (brightness > 0.8) {
          ctx.fillStyle = color
        } else {
          ctx.fillStyle = `${color}88`
        }

        ctx.fillText(char, x, y)

        // Reset column to top randomly
        if (y > canvas.height && Math.random() > 0.975) {
          columns[i] = 0
        }
        columns[i]++
      }
    }

    const startDrawing = () => {
      resize()
      if (interval) clearInterval(interval)
      if (columns.length > 0) {
        interval = setInterval(draw, speed)
      }
    }

    const ro = new ResizeObserver(startDrawing)
    ro.observe(canvas)
    window.addEventListener('resize', startDrawing)

    startDrawing()

    return () => {
      if (interval) clearInterval(interval)
      ro.disconnect()
      window.removeEventListener('resize', startDrawing)
    }
  }, [color, fontSize, speed])

  return (
    <canvas
      ref={canvasRef}
      className={`pointer-events-none fixed inset-0 z-0 h-screen w-screen ${className}`}
      style={{ opacity }}
    />
  )
}
