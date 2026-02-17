'use client';

import { cn } from '../lib/cn';

export interface TopologySvgKeyshareProps {
  className?: string;
}

export function TopologySvgKeyshare({ className }: TopologySvgKeyshareProps) {
  const serverX = 350;
  const serverY = 105;
  const aliceX = 100;
  const aliceY = 105;
  const bobX = 600;
  const bobY = 105;

  return (
    <svg
      viewBox="0 0 700 210"
      className={cn('w-full max-w-[700px] h-auto', className)}
      style={{ minHeight: 210 }}
    >
      <defs>
        <filter id="keyshare-glow-pink">
          <feDropShadow
            dx="0"
            dy="0"
            stdDeviation="4"
            floodColor="#f472b6"
            floodOpacity="0.3"
          />
        </filter>
        <filter id="keyshare-glow-blue">
          <feDropShadow
            dx="0"
            dy="0"
            stdDeviation="4"
            floodColor="#3b82f6"
            floodOpacity="0.25"
          />
        </filter>
        <filter id="keyshare-glow-purple">
          <feDropShadow
            dx="0"
            dy="0"
            stdDeviation="4"
            floodColor="#8b5cf6"
            floodOpacity="0.25"
          />
        </filter>
      </defs>

      {/* Orbit ring around server */}
      <ellipse
        cx={serverX}
        cy={serverY}
        rx="90"
        ry="60"
        fill="none"
        stroke="#1a1a1a"
        strokeWidth="1"
        strokeDasharray="4 8"
      />

      {/* Connection lines: Alice -> Server */}
      <line
        x1={aliceX}
        y1={aliceY}
        x2={serverX}
        y2={serverY}
        stroke="#3b82f6"
        strokeWidth="1.5"
        opacity="0.25"
      />
      <line
        x1={aliceX}
        y1={aliceY}
        x2={serverX}
        y2={serverY}
        stroke="#3b82f6"
        strokeWidth="1"
        strokeDasharray="4 2"
        opacity="0.5"
      >
        <animate
          attributeName="stroke-dashoffset"
          from="20"
          to="0"
          dur="1s"
          repeatCount="indefinite"
        />
      </line>

      {/* Connection lines: Server -> Bob */}
      <line
        x1={serverX}
        y1={serverY}
        x2={bobX}
        y2={bobY}
        stroke="#8b5cf6"
        strokeWidth="1.5"
        opacity="0.25"
      />
      <line
        x1={serverX}
        y1={serverY}
        x2={bobX}
        y2={bobY}
        stroke="#8b5cf6"
        strokeWidth="1"
        strokeDasharray="4 2"
        opacity="0.5"
      >
        <animate
          attributeName="stroke-dashoffset"
          from="20"
          to="0"
          dur="1s"
          repeatCount="indefinite"
        />
      </line>

      {/* Key transfer: pink particle Alice -> Server -> Bob */}
      <g opacity="0">
        <animateMotion
          dur="4s"
          repeatCount="indefinite"
          path={`M${aliceX},${aliceY} L${serverX},${serverY} L${bobX},${bobY}`}
        />
        <animate
          attributeName="opacity"
          values="0;1;1;1;0"
          dur="4s"
          repeatCount="indefinite"
        />
        <rect
          x="-10"
          y="-5"
          width="20"
          height="10"
          rx="2.5"
          fill="#f472b6"
          opacity="0.9"
        />
        <text
          x="0"
          y="1"
          textAnchor="middle"
          fill="white"
          fontSize="6"
          fontFamily="'JetBrains Mono', monospace"
          dominantBaseline="middle"
        >
          KEY
        </text>
      </g>

      {/* Data particles Alice <-> Server (encrypted data) */}
      <circle r="3" fill="#3b82f6" opacity="0">
        <animateMotion
          dur="2.2s"
          repeatCount="indefinite"
          path={`M${aliceX},${aliceY} L${serverX},${serverY}`}
        />
        <animate
          attributeName="opacity"
          values="0;0.8;0.8;0"
          dur="2.2s"
          repeatCount="indefinite"
        />
      </circle>
      <circle r="3" fill="#3b82f6" opacity="0">
        <animateMotion
          dur="2.6s"
          begin="0.9s"
          repeatCount="indefinite"
          path={`M${serverX},${serverY} L${aliceX},${aliceY}`}
        />
        <animate
          attributeName="opacity"
          values="0;0.6;0.6;0"
          dur="2.6s"
          begin="0.9s"
          repeatCount="indefinite"
        />
      </circle>

      {/* Data particles Server <-> Bob (encrypted data) */}
      <circle r="3" fill="#8b5cf6" opacity="0">
        <animateMotion
          dur="2.2s"
          begin="0.5s"
          repeatCount="indefinite"
          path={`M${serverX},${serverY} L${bobX},${bobY}`}
        />
        <animate
          attributeName="opacity"
          values="0;0.8;0.8;0"
          dur="2.2s"
          begin="0.5s"
          repeatCount="indefinite"
        />
      </circle>
      <circle r="3" fill="#8b5cf6" opacity="0">
        <animateMotion
          dur="2.6s"
          begin="1.4s"
          repeatCount="indefinite"
          path={`M${bobX},${bobY} L${serverX},${serverY}`}
        />
        <animate
          attributeName="opacity"
          values="0;0.6;0.6;0"
          dur="2.6s"
          begin="1.4s"
          repeatCount="indefinite"
        />
      </circle>

      {/* Server node - center with encrypt-colored pulse rings */}
      <circle
        cx={serverX}
        cy={serverY}
        r="40"
        fill="none"
        stroke="#f472b6"
        strokeWidth="0.5"
        opacity="0"
      >
        <animate
          attributeName="r"
          from="28"
          to="52"
          dur="3s"
          repeatCount="indefinite"
        />
        <animate
          attributeName="opacity"
          from="0.25"
          to="0"
          dur="3s"
          repeatCount="indefinite"
        />
      </circle>
      <circle
        cx={serverX}
        cy={serverY}
        r="40"
        fill="none"
        stroke="#f472b6"
        strokeWidth="0.5"
        opacity="0"
      >
        <animate
          attributeName="r"
          from="28"
          to="52"
          dur="3s"
          begin="1.5s"
          repeatCount="indefinite"
        />
        <animate
          attributeName="opacity"
          from="0.25"
          to="0"
          dur="3s"
          begin="1.5s"
          repeatCount="indefinite"
        />
      </circle>
      <circle
        cx={serverX}
        cy={serverY}
        r="28"
        fill="#0c0c0c"
        stroke="#f472b6"
        strokeWidth="2"
        filter="url(#keyshare-glow-pink)"
      />
      <circle
        cx={serverX}
        cy={serverY}
        r="14"
        fill="rgba(244,114,182,0.1)"
        stroke="#f472b6"
        strokeWidth="1"
      />
      {/* Lock icon inside server */}
      <rect
        x={serverX - 5}
        y={serverY - 1}
        width="10"
        height="8"
        rx="1.5"
        fill="none"
        stroke="#f472b6"
        strokeWidth="1.3"
      />
      <path
        d={`M${serverX - 3} ${serverY - 1} V${serverY - 4} a3 3 0 0 1 6 0 V${serverY - 1}`}
        fill="none"
        stroke="#f472b6"
        strokeWidth="1.3"
      />
      <circle cx={serverX} cy={serverY + 3} r="0.8" fill="#f472b6" />
      <text
        x={serverX}
        y={serverY + 44}
        textAnchor="middle"
        fill="#555"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="9"
        letterSpacing="2"
      >
        SERVER
      </text>
      <text
        x={serverX}
        y={serverY + 54}
        textAnchor="middle"
        fill="#f472b6"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="7"
        opacity="0.5"
      >
        ciphertext relay
      </text>

      {/* Alice node - left (blue) */}
      <circle
        cx={aliceX}
        cy={aliceY}
        r="24"
        fill="#0c0c0c"
        stroke="#3b82f6"
        strokeWidth="2"
        filter="url(#keyshare-glow-blue)"
      />
      <circle
        cx={aliceX}
        cy={aliceY}
        r="11"
        fill="rgba(59,130,246,0.12)"
        stroke="#3b82f6"
        strokeWidth="1"
      />
      <text
        x={aliceX}
        y={aliceY + 4}
        textAnchor="middle"
        fill="#3b82f6"
        fontFamily="'Inter Tight', system-ui, sans-serif"
        fontWeight="700"
        fontSize="14"
      >
        A
      </text>
      <text
        x={aliceX}
        y={aliceY - 32}
        textAnchor="middle"
        fill="#3b82f6"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="8"
        letterSpacing="1"
        opacity="0.8"
      >
        ALICE
      </text>
      <text
        x={aliceX}
        y={aliceY + 38}
        textAnchor="middle"
        fill="#444"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="7"
      >
        key owner
      </text>

      {/* Bob node - right (purple) */}
      <circle
        cx={bobX}
        cy={bobY}
        r="24"
        fill="#0c0c0c"
        stroke="#8b5cf6"
        strokeWidth="2"
        filter="url(#keyshare-glow-purple)"
      />
      <circle
        cx={bobX}
        cy={bobY}
        r="11"
        fill="rgba(139,92,246,0.12)"
        stroke="#8b5cf6"
        strokeWidth="1"
      />
      <text
        x={bobX}
        y={bobY + 4}
        textAnchor="middle"
        fill="#8b5cf6"
        fontFamily="'Inter Tight', system-ui, sans-serif"
        fontWeight="700"
        fontSize="14"
      >
        B
      </text>
      <text
        x={bobX}
        y={bobY - 32}
        textAnchor="middle"
        fill="#8b5cf6"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="8"
        letterSpacing="1"
        opacity="0.8"
      >
        BOB
      </text>
      <text
        x={bobX}
        y={bobY + 38}
        textAnchor="middle"
        fill="#444"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="7"
      >
        recipient
      </text>

      {/* Transport labels */}
      <text
        x={(aliceX + serverX) / 2}
        y={aliceY - 22}
        textAnchor="middle"
        fill="#3b82f6"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="7"
        opacity="0.35"
        letterSpacing="1.5"
      >
        ENCRYPTED
      </text>
      <text
        x={(serverX + bobX) / 2}
        y={bobY - 22}
        textAnchor="middle"
        fill="#8b5cf6"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="7"
        opacity="0.35"
        letterSpacing="1.5"
      >
        ENCRYPTED
      </text>

      {/* Key transfer label */}
      <text
        x={serverX}
        y={serverY - 56}
        textAnchor="middle"
        fill="#f472b6"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="7"
        opacity="0.4"
        letterSpacing="1"
      >
        BIP39 KEY EXCHANGE
      </text>
    </svg>
  );
}
