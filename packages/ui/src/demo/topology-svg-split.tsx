'use client';

import { cn } from '../lib/cn';

export interface TopologySvgSplitProps {
  className?: string;
}

export function TopologySvgSplit({ className }: TopologySvgSplitProps) {
  const serverX = 350;
  const serverY = 100;
  const clientAX = 100;
  const clientAY = 100;
  const clientBX = 600;
  const clientBY = 100;

  return (
    <svg
      viewBox="0 0 700 200"
      className={cn('w-full max-w-[700px] h-auto', className)}
      style={{ minHeight: 200 }}
    >
      <defs>
        <filter id="split-glow-green">
          <feDropShadow
            dx="0"
            dy="0"
            stdDeviation="4"
            floodColor="#22c55e"
            floodOpacity="0.3"
          />
        </filter>
        <filter id="split-glow-blue">
          <feDropShadow
            dx="0"
            dy="0"
            stdDeviation="4"
            floodColor="#3b82f6"
            floodOpacity="0.25"
          />
        </filter>
        <filter id="split-glow-purple">
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

      {/* Connection lines: A -> Server */}
      <line
        x1={clientAX}
        y1={clientAY}
        x2={serverX}
        y2={serverY}
        stroke="#3b82f6"
        strokeWidth="1.5"
        opacity="0.3"
      />
      <line
        x1={clientAX}
        y1={clientAY}
        x2={serverX}
        y2={serverY}
        stroke="#3b82f6"
        strokeWidth="1"
        strokeDasharray="4 2"
        opacity="0.6"
      >
        <animate
          attributeName="stroke-dashoffset"
          from="20"
          to="0"
          dur="1s"
          repeatCount="indefinite"
        />
      </line>

      {/* Connection lines: Server -> B */}
      <line
        x1={serverX}
        y1={serverY}
        x2={clientBX}
        y2={clientBY}
        stroke="#8b5cf6"
        strokeWidth="1.5"
        opacity="0.3"
      />
      <line
        x1={serverX}
        y1={serverY}
        x2={clientBX}
        y2={clientBY}
        stroke="#8b5cf6"
        strokeWidth="1"
        strokeDasharray="4 2"
        opacity="0.6"
      >
        <animate
          attributeName="stroke-dashoffset"
          from="20"
          to="0"
          dur="1s"
          repeatCount="indefinite"
        />
      </line>

      {/* Data particles A -> Server */}
      <circle r="3" fill="#3b82f6" opacity="0">
        <animateMotion
          dur="2s"
          repeatCount="indefinite"
          path={`M${clientAX},${clientAY} L${serverX},${serverY}`}
        />
        <animate
          attributeName="opacity"
          values="0;0.9;0.9;0"
          dur="2s"
          repeatCount="indefinite"
        />
      </circle>
      <circle r="3" fill="#3b82f6" opacity="0">
        <animateMotion
          dur="2.5s"
          begin="0.8s"
          repeatCount="indefinite"
          path={`M${serverX},${serverY} L${clientAX},${clientAY}`}
        />
        <animate
          attributeName="opacity"
          values="0;0.7;0.7;0"
          dur="2.5s"
          begin="0.8s"
          repeatCount="indefinite"
        />
      </circle>

      {/* Data particles Server -> B */}
      <circle r="3" fill="#8b5cf6" opacity="0">
        <animateMotion
          dur="2s"
          begin="0.5s"
          repeatCount="indefinite"
          path={`M${serverX},${serverY} L${clientBX},${clientBY}`}
        />
        <animate
          attributeName="opacity"
          values="0;0.9;0.9;0"
          dur="2s"
          begin="0.5s"
          repeatCount="indefinite"
        />
      </circle>
      <circle r="3" fill="#8b5cf6" opacity="0">
        <animateMotion
          dur="2.5s"
          begin="1.3s"
          repeatCount="indefinite"
          path={`M${clientBX},${clientBY} L${serverX},${serverY}`}
        />
        <animate
          attributeName="opacity"
          values="0;0.7;0.7;0"
          dur="2.5s"
          begin="1.3s"
          repeatCount="indefinite"
        />
      </circle>

      {/* Server node - center with pulse rings */}
      <circle
        cx={serverX}
        cy={serverY}
        r="40"
        fill="none"
        stroke="#22c55e"
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
          from="0.3"
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
        stroke="#22c55e"
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
          from="0.3"
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
        stroke="#22c55e"
        strokeWidth="2"
        filter="url(#split-glow-green)"
      />
      <circle
        cx={serverX}
        cy={serverY}
        r="14"
        fill="rgba(34,197,94,0.12)"
        stroke="#22c55e"
        strokeWidth="1"
      />
      {/* Database icon */}
      <ellipse
        cx={serverX}
        cy={serverY - 3}
        rx="6"
        ry="3"
        fill="none"
        stroke="#22c55e"
        strokeWidth="1.2"
      />
      <path
        d={`M${serverX - 6} ${serverY - 3} v6 c0 1.7 2.7 3 6 3 s6-1.3 6-3 v-6`}
        fill="none"
        stroke="#22c55e"
        strokeWidth="1.2"
      />
      <ellipse
        cx={serverX}
        cy={serverY + 3}
        rx="6"
        ry="3"
        fill="none"
        stroke="#22c55e"
        strokeWidth="0.8"
        opacity="0.5"
      />
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

      {/* Client A node */}
      <circle
        cx={clientAX}
        cy={clientAY}
        r="22"
        fill="#0c0c0c"
        stroke="#3b82f6"
        strokeWidth="2"
        filter="url(#split-glow-blue)"
      />
      <circle
        cx={clientAX}
        cy={clientAY}
        r="10"
        fill="rgba(59,130,246,0.12)"
        stroke="#3b82f6"
        strokeWidth="1"
      />
      <circle cx={clientAX} cy={clientAY} r="4" fill="#3b82f6" />
      <text
        x={clientAX}
        y={clientAY + 34}
        textAnchor="middle"
        fill="#3b82f6"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="8"
        letterSpacing="1"
        opacity="0.8"
      >
        CLIENT A
      </text>
      <text
        x={clientAX}
        y={clientAY + 44}
        textAnchor="middle"
        fill="#444"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="7"
      >
        wa-sqlite
      </text>

      {/* Client B node */}
      <circle
        cx={clientBX}
        cy={clientBY}
        r="22"
        fill="#0c0c0c"
        stroke="#8b5cf6"
        strokeWidth="2"
        filter="url(#split-glow-purple)"
      />
      <circle
        cx={clientBX}
        cy={clientBY}
        r="10"
        fill="rgba(139,92,246,0.12)"
        stroke="#8b5cf6"
        strokeWidth="1"
      />
      <circle cx={clientBX} cy={clientBY} r="4" fill="#8b5cf6" />
      <text
        x={clientBX}
        y={clientBY + 34}
        textAnchor="middle"
        fill="#8b5cf6"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="8"
        letterSpacing="1"
        opacity="0.8"
      >
        CLIENT B
      </text>
      <text
        x={clientBX}
        y={clientBY + 44}
        textAnchor="middle"
        fill="#444"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="7"
      >
        PGlite
      </text>

      {/* Transport labels */}
      <text
        x={(clientAX + serverX) / 2}
        y={clientAY - 22}
        textAnchor="middle"
        fill="#3b82f6"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="7"
        opacity="0.4"
        letterSpacing="1.5"
      >
        HTTP / WS
      </text>
      <text
        x={(serverX + clientBX) / 2}
        y={clientBY - 22}
        textAnchor="middle"
        fill="#8b5cf6"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="7"
        opacity="0.4"
        letterSpacing="1.5"
      >
        HTTP / WS
      </text>
    </svg>
  );
}
