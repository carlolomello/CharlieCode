/**
 * Charlie, in pixel art.
 *
 * A full-body little guy with glasses and a fringe falling over them, drawn on a
 * 32×32 grid so every pixel stays crisp at any size. Two poses:
 *
 * - `Mascot` walks (two-frame sprite swap, legs and arms mirrored, one-pixel bob)
 * - `MascotDesk` sits at a desk typing when the agent is working
 */
export type MascotMood = 'idle' | 'thinking' | 'happy' | 'worried'

interface MascotProps {
  size?: number
  mood?: MascotMood
  className?: string
  /** Freeze the walk cycle, e.g. for a static avatar. */
  still?: boolean
}

const HAIR = '#3a2a22'
const HAIR_LIGHT = '#5a4133'
const SKIN = '#f3c9a2'
const SKIN_SHADE = '#d9a97f'
const FRAME = '#1b2430'
const LENS = '#d6efff'
const PUPIL = '#101820'
const SHIRT = '#262a31'
const SHIRT_DARK = '#191c21'
const SLEEVE = '#2f343c'
const SHIRT_EDGE = '#3d434d'
const PANTS = '#6b4a2f'
const PANTS_DARK = '#553a25'
const SHOE = '#f2f5f9'
const SHOE_DARK = '#c7ced8'
const MOUTH = '#7a3f3a'
const DESK = '#5a4633'
const DESK_DARK = '#3f3124'
const SCREEN = '#0d1a24'
const SCREEN_LINE = '#57d6a8'
const SCREEN_LINE_2 = '#5b86ff'

/** One pixel-grid rectangle. */
function px(x: number, y: number, w: number, h: number, fill: string): React.JSX.Element {
  return <rect x={x} y={y} width={w} height={h} fill={fill} />
}

function Head({ mood }: { mood: MascotMood }): React.JSX.Element {
  return (
    <g>
      {/* hair silhouette + ears */}
      {px(9, 5, 2, 10, HAIR)}
      {px(21, 5, 2, 10, HAIR)}
      {px(10, 11, 1, 3, SKIN_SHADE)}
      {px(21, 11, 1, 3, SKIN_SHADE)}

      {/* face */}
      {px(12, 7, 8, 9, SKIN)}

      {/* hair: top, cowlick, forehead */}
      {px(11, 3, 10, 1, HAIR)}
      {px(10, 4, 12, 4, HAIR)}
      {px(11, 7, 10, 2, HAIR)}
      {px(14, 2, 2, 1, HAIR)}
      {px(15, 1, 1, 1, HAIR)}
      {px(13, 4, 3, 1, HAIR_LIGHT)}
      {px(18, 4, 2, 1, HAIR_LIGHT)}

      {/* glasses: two lenses, bridge, temples */}
      {px(9, 11, 2, 1, FRAME)}
      {px(21, 11, 2, 1, FRAME)}
      {px(11, 10, 4, 4, FRAME)}
      {px(17, 10, 4, 4, FRAME)}
      {px(15, 11, 2, 1, FRAME)}
      {px(12, 11, 2, 2, LENS)}
      {px(18, 11, 2, 2, LENS)}
      {px(mood === 'worried' ? 12 : 13, 12, 1, 1, PUPIL)}
      {px(mood === 'worried' ? 18 : 19, 12, 1, 1, PUPIL)}

      {/* fringe strands, drawn after the glasses so they fall in front */}
      {px(12, 9, 1, 3, HAIR)}
      {px(14, 9, 1, 2, HAIR)}
      {px(18, 9, 1, 3, HAIR)}
      {px(20, 9, 1, 2, HAIR)}
      {px(13, 9, 1, 1, HAIR_LIGHT)}

      {/* cheeks + mouth */}
      {px(11, 13, 1, 1, '#ef9d9d')}
      {px(20, 13, 1, 1, '#ef9d9d')}
      {mood === 'happy'
        ? px(14, 14, 4, 1, MOUTH)
        : mood === 'worried'
          ? px(15, 14, 2, 1, MOUTH)
          : mood === 'thinking'
            ? px(15, 14, 1, 1, MOUTH)
            : px(15, 14, 2, 1, MOUTH)}
    </g>
  )
}

function Torso(): React.JSX.Element {
  return (
    <g>
      {px(12, 16, 3, 1, SHIRT_DARK)}
      {px(17, 16, 3, 1, SHIRT_DARK)}
      {px(15, 16, 2, 1, SKIN_SHADE)}
      {px(11, 17, 10, 7, SHIRT)}
      {px(11, 17, 10, 1, SHIRT_EDGE)}
      {px(13, 18, 6, 1, SHIRT_DARK)}
      {px(15, 19, 1, 2, SHIRT_DARK)}
      {px(14, 21, 4, 1, SHIRT_DARK)}
    </g>
  )
}

/**
 * Frame A: left leg forward (shoe lower and wider), right arm swung forward.
 * The displacement is deliberately exaggerated: at 38px a subtle step reads as
 * "standing still with a twitch".
 */
function FrameA(): React.JSX.Element {
  return (
    <g className="walk-frame-a">
      {/* left arm down/back, right arm forward/up */}
      {px(8, 17, 2, 6, SLEEVE)}
      {px(8, 23, 2, 1, SKIN)}
      {px(22, 17, 2, 3, SLEEVE)}
      {px(22, 20, 2, 1, SKIN)}
      {/* left leg forward, right leg bent back */}
      {px(13, 24, 2, 5, PANTS)}
      {px(13, 28, 1, 1, PANTS_DARK)}
      {px(11, 29, 4, 1, SHOE)}
      {px(18, 23, 2, 4, PANTS)}
      {px(18, 27, 3, 1, SHOE_DARK)}
    </g>
  )
}

/** Frame B: mirrored — right leg forward, left arm swung forward. */
function FrameB(): React.JSX.Element {
  return (
    <g className="walk-frame-b">
      {px(8, 17, 2, 3, SLEEVE)}
      {px(8, 20, 2, 1, SKIN)}
      {px(22, 17, 2, 6, SLEEVE)}
      {px(22, 23, 2, 1, SKIN)}
      {px(13, 23, 2, 4, PANTS)}
      {px(13, 27, 3, 1, SHOE_DARK)}
      {px(17, 24, 2, 5, PANTS)}
      {px(18, 28, 1, 1, PANTS_DARK)}
      {px(17, 29, 4, 1, SHOE)}
    </g>
  )
}

/** Feet together, arms down: what Charlie does between walks. */
function Standing(): React.JSX.Element {
  return (
    <g className="pose-stand">
      {px(8, 17, 2, 6, SLEEVE)}
      {px(8, 23, 2, 1, SKIN)}
      {px(22, 17, 2, 6, SLEEVE)}
      {px(22, 23, 2, 1, SKIN)}
      {px(13, 24, 2, 5, PANTS)}
      {px(12, 29, 3, 1, SHOE)}
      {px(17, 24, 2, 5, PANTS)}
      {px(17, 29, 3, 1, SHOE)}
    </g>
  )
}

/** Standing with a hand on the chin and a thought bubble. */
function Thinking(): React.JSX.Element {
  return (
    <g className="pose-think">
      {px(8, 17, 2, 6, SLEEVE)}
      {px(8, 23, 2, 1, SKIN)}
      {px(21, 18, 2, 3, SLEEVE)}
      {px(19, 15, 3, 2, SLEEVE)}
      {px(18, 14, 2, 1, SKIN_SHADE)}
      {px(13, 24, 2, 5, PANTS)}
      {px(12, 29, 3, 1, SHOE)}
      {px(17, 24, 2, 5, PANTS)}
      {px(17, 29, 3, 1, SHOE)}
      {/* thought bubble */}
      {px(24, 4, 5, 4, '#e8eef7')}
      {px(23, 7, 1, 1, '#e8eef7')}
      {px(25, 5, 1, 1, '#3a4a5a')}
      {px(27, 5, 1, 1, '#3a4a5a')}
      {px(25, 7, 1, 1, '#3a4a5a')}
    </g>
  )
}

export function Mascot({ size = 56, mood = 'idle', className, still }: MascotProps): React.JSX.Element {
  return (
    <svg
      className={`mascot ${mood} ${still ? 'still' : ''} ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      shapeRendering="crispEdges"
      role="img"
      aria-label="Charlie, la mascotte"
    >
      {/* ground shadow */}
      <ellipse cx="16" cy="31" rx="8" ry="1.4" fill="#000000" opacity="0.28" />

      <g className="mascot-bob">
        <Torso />
        <Head mood={mood} />
        <Standing />
        <Thinking />
        <FrameA />
        <FrameB />
      </g>
    </svg>
  )
}

/**
 * Charlie at his desk, typing. Used while the agent is working.
 *
 * Wider viewBox (40×32) because a desk needs horizontal room; the character sits
 * on the left, the monitor is on the right, and the hands alternate on the
 * keyboard.
 */
export function MascotDesk({
  width = 148,
  mood = 'thinking',
  className
}: {
  width?: number
  mood?: MascotMood
  className?: string
}): React.JSX.Element {
  return (
    <svg
      className={`mascot desk ${mood} ${className ?? ''}`}
      width={width}
      height={(width * 32) / 40}
      viewBox="0 0 40 32"
      shapeRendering="crispEdges"
      role="img"
      aria-label="Charlie al computer"
    >
      {/* floor + desk shadow */}
      <ellipse cx="22" cy="30.5" rx="15" ry="1.6" fill="#000000" opacity="0.26" />

      {/* chair */}
      {px(6, 12, 2, 11, '#2a2f38')}
      {px(6, 22, 7, 1, '#333a45')}
      {px(7, 23, 1, 6, '#22272f')}
      {px(11, 23, 1, 6, '#22272f')}

      {/* sitting Charlie: head shifted onto the chair */}
      <g transform="translate(-3,-2)">
        <Head mood={mood} />
      </g>
      {/* torso */}
      {px(8, 15, 8, 6, SHIRT)}
      {px(8, 15, 8, 1, SHIRT_EDGE)}
      {px(8, 20, 8, 1, SHIRT_DARK)}
      {/* thighs + lower legs + shoes */}
      {px(8, 21, 7, 2, PANTS)}
      {px(13, 23, 2, 5, PANTS)}
      {px(12, 28, 4, 1, SHOE)}
      {px(9, 23, 2, 1, PANTS_DARK)}

      {/* arms reaching the keyboard */}
      <g className="desk-hands">
        {px(15, 17, 4, 1, SLEEVE)}
        {px(18, 17, 2, 1, SKIN)}
      </g>
      <g className="desk-hands-alt">
        {px(15, 19, 4, 1, SLEEVE)}
        {px(18, 19, 2, 1, SKIN)}
      </g>

      {/* desk */}
      {px(19, 20, 20, 2, DESK)}
      {px(19, 22, 20, 1, DESK_DARK)}
      {px(21, 23, 2, 7, DESK_DARK)}
      {px(35, 23, 2, 7, DESK_DARK)}

      {/* keyboard */}
      {px(20, 19, 9, 1, '#7b8794')}
      {px(21, 18, 1, 1, '#a9b4c0')}
      {px(23, 18, 1, 1, '#a9b4c0')}
      {px(25, 18, 1, 1, '#a9b4c0')}
      {px(27, 18, 1, 1, '#a9b4c0')}

      {/* monitor */}
      {px(27, 18, 2, 2, '#3a4048')}
      {px(25, 19, 6, 1, '#3a4048')}
      {px(23, 7, 14, 11, '#2b3038')}
      {px(24, 8, 12, 9, SCREEN)}
      {px(25, 9, 5, 1, SCREEN_LINE)}
      {px(25, 11, 8, 1, '#3a4a5a')}
      {px(25, 12, 6, 1, SCREEN_LINE_2)}
      {px(25, 13, 7, 1, '#3a4a5a')}
      {px(25, 14, 4, 1, SCREEN_LINE)}
      <rect className="desk-cursor" x="25" y="15" width="1" height="1" fill="#d7f5e9" />

      {/* mug + steam */}
      {px(33, 17, 3, 3, '#8a6a4f')}
      {px(36, 18, 1, 1, '#8a6a4f')}
      <g className="desk-steam">
        {px(34, 15, 1, 1, '#c9d4e0')}
        {px(35, 14, 1, 1, '#c9d4e0')}
      </g>
    </svg>
  )
}
