'use client';

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';
import type { SyncClientNode } from '../lib/types';

export type TopologyNodePosition = {
  clientId: string;
  x: number;
  y: number;
};

export type TopologyHeroProps = ComponentPropsWithoutRef<'div'> & {
  clients: SyncClientNode[];
  /** Positions for each client node keyed by client id */
  positions?: TopologyNodePosition[];
  /** IDs of clients connecting through the relay */
  relayClientIds?: string[];
  /** Override server position */
  serverPosition?: { x: number; y: number };
  /** Override relay position */
  relayPosition?: { x: number; y: number };
  /** SVG viewBox dimensions */
  viewBox?: { width: number; height: number };
  /** Stats overlay: total nodes */
  totalNodes?: number;
  /** Stats overlay: online count */
  onlineCount?: number;
  /** Stats overlay: offline count */
  offlineCount?: number;
};

function getStatusColor(status: string) {
  if (status === 'online') return '#22c55e';
  if (status === 'syncing') return '#f59e0b';
  return '#ef4444';
}

const TopologyHero = forwardRef<HTMLDivElement, TopologyHeroProps>(
  (
    {
      className,
      clients,
      positions,
      relayClientIds = [],
      serverPosition = { x: 420, y: 190 },
      relayPosition = { x: 780, y: 190 },
      viewBox = { width: 1200, height: 380 },
      totalNodes,
      onlineCount,
      offlineCount,
      ...props
    },
    ref
  ) => {
    const sX = serverPosition.x;
    const sY = serverPosition.y;
    const rX = relayPosition.x;
    const rY = relayPosition.y;

    const defaultPositions: Record<string, { x: number; y: number }> = {};
    const angleStep = (2 * Math.PI) / Math.max(clients.length, 1);
    clients.forEach((c, i) => {
      const isRelay = relayClientIds.includes(c.id);
      const cx = isRelay ? rX : sX;
      const cy = isRelay ? rY : sY;
      const rx = isRelay ? 240 : 260;
      const ry = isRelay ? 130 : 150;
      const angle = angleStep * i - Math.PI / 2;
      defaultPositions[c.id] = {
        x: cx + rx * Math.cos(angle),
        y: cy + ry * Math.sin(angle),
      };
    });

    const posMap: Record<string, { x: number; y: number }> = {};
    if (positions) {
      for (const p of positions) {
        posMap[p.clientId] = { x: p.x, y: p.y };
      }
    }

    function getPos(clientId: string) {
      return (
        posMap[clientId] ?? defaultPositions[clientId] ?? { x: 600, y: 190 }
      );
    }

    const computedTotalNodes = totalNodes ?? clients.length + 2;
    const computedOnline =
      onlineCount ?? clients.filter((c) => c.status !== 'offline').length;
    const computedOffline =
      offlineCount ?? clients.filter((c) => c.status === 'offline').length;

    return (
      <div
        ref={ref}
        className={cn(
          'relative overflow-hidden',
          'bg-[radial-gradient(ellipse_at_35%_50%,rgba(59,130,246,0.06)_0%,transparent_50%),radial-gradient(ellipse_at_68%_50%,rgba(139,92,246,0.04)_0%,transparent_40%),#0c0c0c]',
          'bg-[image:radial-gradient(circle_at_1px_1px,#1a1a1a_1px,transparent_0)] bg-[size:24px_24px]',
          className
        )}
        style={{ height: 420 }}
        {...props}
      >
        {/* Scan line */}
        <div className="absolute left-0 right-0 h-px bg-[linear-gradient(90deg,transparent,rgba(59,130,246,0.3),transparent)] animate-[scanSweep_6s_ease-in-out_infinite] pointer-events-none" />

        {/* Label top-left */}
        <div className="absolute top-4 left-5 z-10">
          <span className="font-mono text-[10px] text-neutral-500 uppercase tracking-widest">
            Sync Topology
          </span>
        </div>

        {/* Stats top-right */}
        <div className="absolute top-4 right-5 z-10 flex items-center gap-3">
          <span className="font-mono text-[10px] text-neutral-600">
            {computedTotalNodes} nodes
          </span>
          <span className="font-mono text-[10px] text-neutral-600">
            &middot;
          </span>
          <span className="font-mono text-[10px] text-healthy">
            {computedOnline} online
          </span>
          <span className="font-mono text-[10px] text-neutral-600">
            &middot;
          </span>
          <span className="font-mono text-[10px] text-offline">
            {computedOffline} offline
          </span>
        </div>

        {/* SVG topology */}
        <svg
          viewBox={`0 0 ${viewBox.width} ${viewBox.height}`}
          className="w-full h-full"
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Orbit rings */}
          <ellipse
            cx={sX}
            cy={sY}
            rx={280}
            ry={160}
            fill="none"
            stroke="#1a1a1a"
            strokeWidth={0.5}
            strokeDasharray="6 10"
          />
          <ellipse
            cx={rX}
            cy={rY}
            rx={260}
            ry={140}
            fill="none"
            stroke="#1a1a1a"
            strokeWidth={0.5}
            strokeDasharray="6 10"
          />

          {/* Server-Relay backbone */}
          <line
            x1={sX}
            y1={sY}
            x2={rX}
            y2={rY}
            stroke="#8b5cf6"
            strokeWidth={2}
            opacity={0.3}
          />
          <line
            x1={sX}
            y1={sY}
            x2={rX}
            y2={rY}
            stroke="#8b5cf6"
            strokeWidth={1}
            strokeDasharray="4 2"
            opacity={0.6}
          >
            <animate
              attributeName="stroke-dashoffset"
              from="20"
              to="0"
              dur="1s"
              repeatCount="indefinite"
            />
          </line>
          {/* Backbone particles */}
          <circle r={3} fill="#8b5cf6" opacity={0.8}>
            <animateMotion
              dur="2.5s"
              repeatCount="indefinite"
              path={`M${sX},${sY} L${rX},${rY}`}
            />
            <animate
              attributeName="opacity"
              values="0;0.8;0.8;0"
              dur="2.5s"
              repeatCount="indefinite"
            />
          </circle>
          <circle r={3} fill="#8b5cf6" opacity={0.8}>
            <animateMotion
              dur="2.5s"
              begin="1.25s"
              repeatCount="indefinite"
              path={`M${rX},${rY} L${sX},${sY}`}
            />
            <animate
              attributeName="opacity"
              values="0;0.8;0.8;0"
              dur="2.5s"
              begin="1.25s"
              repeatCount="indefinite"
            />
          </circle>
          <text
            x={(sX + rX) / 2}
            y={sY - 20}
            textAnchor="middle"
            fill="#8b5cf6"
            fontFamily="JetBrains Mono, monospace"
            fontSize={8}
            opacity={0.4}
            letterSpacing={2}
          >
            BACKBONE
          </text>

          {/* Connection lines + particles for each client */}
          {clients.map((c) => {
            const p = getPos(c.id);
            const isRelay = relayClientIds.includes(c.id);
            const tX = isRelay ? rX : sX;
            const tY = isRelay ? rY : sY;
            const color = getStatusColor(c.status);
            const w = c.status === 'syncing' ? 2.5 : 1.5;

            if (c.status === 'offline') {
              return (
                <line
                  key={`line-${c.id}`}
                  x1={tX}
                  y1={tY}
                  x2={p.x}
                  y2={p.y}
                  stroke={color}
                  strokeWidth={1}
                  strokeDasharray="3 6"
                  opacity={0.2}
                />
              );
            }

            const dur = c.status === 'syncing' ? '1.2s' : '2.8s';
            const halfDur = `${Number.parseFloat(dur) / 2}s`;

            return (
              <g key={`line-${c.id}`}>
                <line
                  x1={tX}
                  y1={tY}
                  x2={p.x}
                  y2={p.y}
                  stroke={color}
                  strokeWidth={w}
                  strokeDasharray="4 2"
                >
                  <animate
                    attributeName="stroke-dashoffset"
                    from="20"
                    to="0"
                    dur="1s"
                    repeatCount="indefinite"
                  />
                </line>
                <circle r={2.5} fill={color} opacity={0.7}>
                  <animateMotion
                    dur={dur}
                    repeatCount="indefinite"
                    path={`M${tX},${tY} L${p.x},${p.y}`}
                  />
                  <animate
                    attributeName="opacity"
                    values="0;0.7;0.7;0"
                    dur={dur}
                    repeatCount="indefinite"
                  />
                </circle>
                <circle r={2} fill={color} opacity={0.5}>
                  <animateMotion
                    dur={dur}
                    begin={halfDur}
                    repeatCount="indefinite"
                    path={`M${p.x},${p.y} L${tX},${tY}`}
                  />
                  <animate
                    attributeName="opacity"
                    values="0;0.5;0.5;0"
                    dur={dur}
                    begin={halfDur}
                    repeatCount="indefinite"
                  />
                </circle>
              </g>
            );
          })}

          {/* Server node with pulse rings */}
          <circle
            cx={sX}
            cy={sY}
            r={50}
            fill="none"
            stroke="#3b82f6"
            strokeWidth={0.5}
            opacity={0.15}
          >
            <animate
              attributeName="r"
              from="32"
              to="60"
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
            cx={sX}
            cy={sY}
            r={50}
            fill="none"
            stroke="#3b82f6"
            strokeWidth={0.5}
            opacity={0.15}
          >
            <animate
              attributeName="r"
              from="32"
              to="60"
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
            cx={sX}
            cy={sY}
            r={32}
            fill="#0c0c0c"
            stroke="#3b82f6"
            strokeWidth={2}
            style={{ filter: 'drop-shadow(0 0 12px rgba(59,130,246,0.4))' }}
          />
          <circle
            cx={sX}
            cy={sY}
            r={16}
            fill="rgba(59,130,246,0.12)"
            stroke="#3b82f6"
            strokeWidth={0.8}
          />
          <circle cx={sX} cy={sY} r={6} fill="#3b82f6" />
          <text
            x={sX}
            y={sY + 48}
            textAnchor="middle"
            fill="#444"
            fontFamily="JetBrains Mono, monospace"
            fontSize={9}
            letterSpacing={2.5}
          >
            SERVER
          </text>

          {/* Relay node with pulse */}
          <circle
            cx={rX}
            cy={rY}
            r={40}
            fill="none"
            stroke="#8b5cf6"
            strokeWidth={0.5}
            opacity={0.15}
          >
            <animate
              attributeName="r"
              from="26"
              to="48"
              dur="3.5s"
              repeatCount="indefinite"
            />
            <animate
              attributeName="opacity"
              from="0.2"
              to="0"
              dur="3.5s"
              repeatCount="indefinite"
            />
          </circle>
          <circle
            cx={rX}
            cy={rY}
            r={26}
            fill="#0c0c0c"
            stroke="#8b5cf6"
            strokeWidth={2}
            style={{ filter: 'drop-shadow(0 0 10px rgba(139,92,246,0.35))' }}
          />
          <circle
            cx={rX}
            cy={rY}
            r={13}
            fill="rgba(139,92,246,0.12)"
            stroke="#8b5cf6"
            strokeWidth={0.8}
          />
          <circle cx={rX} cy={rY} r={5} fill="#8b5cf6" />
          <text
            x={rX}
            y={rY + 42}
            textAnchor="middle"
            fill="#444"
            fontFamily="JetBrains Mono, monospace"
            fontSize={9}
            letterSpacing={2.5}
          >
            RELAY
          </text>

          {/* Client nodes */}
          {clients.map((c) => {
            const p = getPos(c.id);
            const color = getStatusColor(c.status);
            const op = c.status === 'offline' ? 0.25 : 1;
            const label = c.actor.replace('user-', '').replace('svc-', '');
            const isRelay = relayClientIds.includes(c.id);

            return (
              <g key={`node-${c.id}`} opacity={op}>
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={20}
                  fill="#0c0c0c"
                  stroke={color}
                  strokeWidth={1.5}
                />
                <circle cx={p.x} cy={p.y} r={5} fill={color} />
                <text
                  x={p.x}
                  y={p.y + 32}
                  textAnchor="middle"
                  fill="#555"
                  fontFamily="JetBrains Mono, monospace"
                  fontSize={9}
                >
                  {label}
                </text>
                <text
                  x={p.x}
                  y={p.y + 42}
                  textAnchor="middle"
                  fill="#333"
                  fontFamily="JetBrains Mono, monospace"
                  fontSize={7}
                >
                  {c.type}
                  {isRelay ? ' \u00b7 relay' : ''}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    );
  }
);
TopologyHero.displayName = 'TopologyHero';

export { TopologyHero };
