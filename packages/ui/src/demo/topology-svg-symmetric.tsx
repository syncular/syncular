'use client';

import { cn } from '../lib/cn';

export interface TopologySvgSymmetricProps {
  className?: string;
}

export function TopologySvgSymmetric({ className }: TopologySvgSymmetricProps) {
  const serverX = 350;
  const serverY = 115;
  const designerX = 90;
  const designerY = 60;
  const developerX = 610;
  const developerY = 60;
  const viewerX = 350;
  const viewerY = 230;

  return (
    <svg
      viewBox="0 0 700 280"
      className={cn('w-full max-w-[700px] h-auto', className)}
      style={{ minHeight: 270 }}
    >
      <defs>
        <filter id="sym-glow-pink">
          <feDropShadow
            dx="0"
            dy="0"
            stdDeviation="4"
            floodColor="#f472b6"
            floodOpacity="0.3"
          />
        </filter>
        <filter id="sym-glow-blue">
          <feDropShadow
            dx="0"
            dy="0"
            stdDeviation="4"
            floodColor="#3b82f6"
            floodOpacity="0.25"
          />
        </filter>
        <filter id="sym-glow-green">
          <feDropShadow
            dx="0"
            dy="0"
            stdDeviation="4"
            floodColor="#22c55e"
            floodOpacity="0.25"
          />
        </filter>
        <filter id="sym-glow-amber">
          <feDropShadow
            dx="0"
            dy="0"
            stdDeviation="4"
            floodColor="#f59e0b"
            floodOpacity="0.25"
          />
        </filter>
      </defs>

      {/* Orbit ring around server */}
      <ellipse
        cx={serverX}
        cy={serverY}
        rx="100"
        ry="75"
        fill="none"
        stroke="#1a1a1a"
        strokeWidth="1"
        strokeDasharray="4 8"
      />

      {/* Connection lines: Designer -> Server */}
      <line
        x1={designerX}
        y1={designerY}
        x2={serverX}
        y2={serverY}
        stroke="#3b82f6"
        strokeWidth="1.5"
        opacity="0.25"
      />
      <line
        x1={designerX}
        y1={designerY}
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

      {/* Connection lines: Developer -> Server */}
      <line
        x1={developerX}
        y1={developerY}
        x2={serverX}
        y2={serverY}
        stroke="#22c55e"
        strokeWidth="1.5"
        opacity="0.25"
      />
      <line
        x1={developerX}
        y1={developerY}
        x2={serverX}
        y2={serverY}
        stroke="#22c55e"
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

      {/* Connection lines: Viewer -> Server */}
      <line
        x1={viewerX}
        y1={viewerY}
        x2={serverX}
        y2={serverY}
        stroke="#f59e0b"
        strokeWidth="1.5"
        opacity="0.25"
      />
      <line
        x1={viewerX}
        y1={viewerY}
        x2={serverX}
        y2={serverY}
        stroke="#f59e0b"
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

      {/* Data particles Designer <-> Server */}
      <circle r="3" fill="#3b82f6" opacity="0">
        <animateMotion
          dur="2.2s"
          repeatCount="indefinite"
          path={`M${designerX},${designerY} L${serverX},${serverY}`}
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
          begin="1s"
          repeatCount="indefinite"
          path={`M${serverX},${serverY} L${designerX},${designerY}`}
        />
        <animate
          attributeName="opacity"
          values="0;0.6;0.6;0"
          dur="2.6s"
          begin="1s"
          repeatCount="indefinite"
        />
      </circle>

      {/* Data particles Developer <-> Server */}
      <circle r="3" fill="#22c55e" opacity="0">
        <animateMotion
          dur="2.2s"
          begin="0.4s"
          repeatCount="indefinite"
          path={`M${developerX},${developerY} L${serverX},${serverY}`}
        />
        <animate
          attributeName="opacity"
          values="0;0.8;0.8;0"
          dur="2.2s"
          begin="0.4s"
          repeatCount="indefinite"
        />
      </circle>
      <circle r="3" fill="#22c55e" opacity="0">
        <animateMotion
          dur="2.6s"
          begin="1.4s"
          repeatCount="indefinite"
          path={`M${serverX},${serverY} L${developerX},${developerY}`}
        />
        <animate
          attributeName="opacity"
          values="0;0.6;0.6;0"
          dur="2.6s"
          begin="1.4s"
          repeatCount="indefinite"
        />
      </circle>

      {/* Data particles Viewer <-> Server */}
      <circle r="3" fill="#f59e0b" opacity="0">
        <animateMotion
          dur="2.2s"
          begin="0.8s"
          repeatCount="indefinite"
          path={`M${viewerX},${viewerY} L${serverX},${serverY}`}
        />
        <animate
          attributeName="opacity"
          values="0;0.8;0.8;0"
          dur="2.2s"
          begin="0.8s"
          repeatCount="indefinite"
        />
      </circle>
      <circle r="3" fill="#f59e0b" opacity="0">
        <animateMotion
          dur="2.6s"
          begin="1.8s"
          repeatCount="indefinite"
          path={`M${serverX},${serverY} L${viewerX},${viewerY}`}
        />
        <animate
          attributeName="opacity"
          values="0;0.6;0.6;0"
          dur="2.6s"
          begin="1.8s"
          repeatCount="indefinite"
        />
      </circle>

      {/* Server node - center with encrypt-colored pulse rings (pink) */}
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
          from="30"
          to="55"
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
          from="30"
          to="55"
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
        r="30"
        fill="#0c0c0c"
        stroke="#f472b6"
        strokeWidth="2"
        filter="url(#sym-glow-pink)"
      />
      <circle
        cx={serverX}
        cy={serverY}
        r="15"
        fill="rgba(244,114,182,0.1)"
        stroke="#f472b6"
        strokeWidth="1"
      />
      {/* Lock icon inside server node */}
      <rect
        x={serverX - 6}
        y={serverY - 2}
        width="12"
        height="9"
        rx="1.5"
        fill="none"
        stroke="#f472b6"
        strokeWidth="1.5"
      />
      <path
        d={`M${serverX - 3.5} ${serverY - 2} V${serverY - 5.5} a3.5 3.5 0 0 1 7 0 V${serverY - 2}`}
        fill="none"
        stroke="#f472b6"
        strokeWidth="1.5"
      />
      <circle cx={serverX} cy={serverY + 2} r="1" fill="#f472b6" />
      <text
        x={serverX}
        y={serverY + 46}
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
        y={serverY + 56}
        textAnchor="middle"
        fill="#f472b6"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="7"
        opacity="0.5"
      >
        ciphertext only
      </text>

      {/* Designer node - top-left (blue) */}
      <circle
        cx={designerX}
        cy={designerY}
        r="22"
        fill="#0c0c0c"
        stroke="#3b82f6"
        strokeWidth="2"
        filter="url(#sym-glow-blue)"
      />
      <circle
        cx={designerX}
        cy={designerY}
        r="10"
        fill="rgba(59,130,246,0.12)"
        stroke="#3b82f6"
        strokeWidth="1"
      />
      {/* Pen icon */}
      <path
        d={`M${designerX - 3} ${designerY + 3} l6 -6 2 2 -6 6z`}
        fill="none"
        stroke="#3b82f6"
        strokeWidth="1.2"
      />
      <text
        x={designerX}
        y={designerY - 30}
        textAnchor="middle"
        fill="#3b82f6"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="8"
        letterSpacing="1"
        opacity="0.8"
      >
        DESIGNER
      </text>

      {/* Developer node - top-right (green) */}
      <circle
        cx={developerX}
        cy={developerY}
        r="22"
        fill="#0c0c0c"
        stroke="#22c55e"
        strokeWidth="2"
        filter="url(#sym-glow-green)"
      />
      <circle
        cx={developerX}
        cy={developerY}
        r="10"
        fill="rgba(34,197,94,0.12)"
        stroke="#22c55e"
        strokeWidth="1"
      />
      {/* Code brackets icon */}
      <text
        x={developerX}
        y={developerY + 4}
        textAnchor="middle"
        fill="#22c55e"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="11"
      >
        {'</>'}
      </text>
      <text
        x={developerX}
        y={developerY - 30}
        textAnchor="middle"
        fill="#22c55e"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="8"
        letterSpacing="1"
        opacity="0.8"
      >
        DEVELOPER
      </text>

      {/* Viewer node - bottom (amber) */}
      <circle
        cx={viewerX}
        cy={viewerY}
        r="22"
        fill="#0c0c0c"
        stroke="#f59e0b"
        strokeWidth="2"
        filter="url(#sym-glow-amber)"
      />
      <circle
        cx={viewerX}
        cy={viewerY}
        r="10"
        fill="rgba(245,158,11,0.12)"
        stroke="#f59e0b"
        strokeWidth="1"
      />
      {/* Eye icon */}
      <ellipse
        cx={viewerX}
        cy={viewerY}
        rx="6"
        ry="3.5"
        fill="none"
        stroke="#f59e0b"
        strokeWidth="1.2"
      />
      <circle cx={viewerX} cy={viewerY} r="1.5" fill="#f59e0b" />
      <text
        x={viewerX}
        y={viewerY + 34}
        textAnchor="middle"
        fill="#f59e0b"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="8"
        letterSpacing="1"
        opacity="0.8"
      >
        VIEWER
      </text>

      {/* Transport labels on connections */}
      <text
        x={(designerX + serverX) / 2 - 15}
        y={(designerY + serverY) / 2 - 12}
        textAnchor="middle"
        fill="#3b82f6"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="7"
        opacity="0.35"
        letterSpacing="1"
      >
        ENCRYPTED
      </text>
      <text
        x={(developerX + serverX) / 2 + 15}
        y={(developerY + serverY) / 2 - 12}
        textAnchor="middle"
        fill="#22c55e"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="7"
        opacity="0.35"
        letterSpacing="1"
      >
        ENCRYPTED
      </text>
      <text
        x={viewerX - 40}
        y={(viewerY + serverY) / 2 + 8}
        textAnchor="end"
        fill="#f59e0b"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="7"
        opacity="0.35"
        letterSpacing="1"
      >
        ENCRYPTED
      </text>
    </svg>
  );
}
