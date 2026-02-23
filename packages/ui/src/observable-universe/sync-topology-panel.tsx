'use client';

import { forwardRef } from 'react';
import { cn } from '../lib/cn';
import { NODE_POSITIONS } from './constants';
import type { ObservableClient } from './types';

export interface SyncTopologyPanelProps {
  clients: ObservableClient[];
  className?: string;
}

const statusStroke: Record<ObservableClient['status'], string> = {
  online: '#22c55e',
  syncing: '#f59e0b',
  offline: '#ef4444',
};

export const SyncTopologyPanel = forwardRef<
  HTMLDivElement,
  SyncTopologyPanelProps
>(function SyncTopologyPanel({ clients, className }, ref) {
  const server = NODE_POSITIONS.server;
  const relay = NODE_POSITIONS.relay;

  return (
    <div
      ref={ref}
      className={cn(
        'dashboard-panel rounded-lg flex flex-col items-center justify-center relative overflow-hidden',
        className
      )}
      style={{
        backgroundImage:
          'radial-gradient(circle at 1px 1px, #1a1a1a 1px, transparent 0)',
        backgroundSize: '24px 24px',
      }}
    >
      <div className="absolute top-3 left-4 z-10">
        <span className="font-mono text-[11px] text-neutral-400 uppercase tracking-wider">
          Sync Topology
        </span>
      </div>
      <svg
        viewBox="0 0 660 420"
        className="w-full max-w-[660px] h-auto"
        style={{ minHeight: 320 }}
      >
        {/* Orbit arcs */}
        <ellipse
          cx={server.x}
          cy={server.y}
          rx={155}
          ry={155}
          fill="none"
          stroke="#1a1a1a"
          strokeWidth={1}
          strokeDasharray="4 8"
        />
        <ellipse
          cx={relay.x}
          cy={relay.y}
          rx={140}
          ry={140}
          fill="none"
          stroke="#1a1a1a"
          strokeWidth={1}
          strokeDasharray="4 8"
        />

        {/* Server-Relay backbone connection */}
        <line
          x1={server.x}
          y1={server.y}
          x2={relay.x}
          y2={relay.y}
          stroke="#8b5cf6"
          strokeWidth={2}
          opacity={0.4}
        />
        <line
          x1={server.x}
          y1={server.y}
          x2={relay.x}
          y2={relay.y}
          stroke="#8b5cf6"
          strokeWidth={1}
          strokeDasharray="4 2"
          opacity={0.7}
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
        <circle r={3} fill="#8b5cf6" opacity={0.9}>
          <animateMotion
            dur="2s"
            repeatCount="indefinite"
            path={`M${server.x},${server.y} L${relay.x},${relay.y}`}
          />
          <animate
            attributeName="opacity"
            values="0;0.9;0.9;0"
            dur="2s"
            repeatCount="indefinite"
          />
        </circle>
        <circle r={3} fill="#8b5cf6" opacity={0.9}>
          <animateMotion
            dur="2s"
            begin="1s"
            repeatCount="indefinite"
            path={`M${relay.x},${relay.y} L${server.x},${server.y}`}
          />
          <animate
            attributeName="opacity"
            values="0;0.9;0.9;0"
            dur="2s"
            begin="1s"
            repeatCount="indefinite"
          />
        </circle>

        {/* Backbone label */}
        <text
          x={(server.x + relay.x) / 2}
          y={server.y - 18}
          textAnchor="middle"
          fill="#8b5cf6"
          fontFamily="JetBrains Mono"
          fontSize={8}
          opacity={0.5}
          letterSpacing={1.5}
        >
          BACKBONE
        </text>

        {/* Client connection lines */}
        {clients.map((client) => {
          const pos = NODE_POSITIONS[client.id];
          if (!pos) return null;
          const targetX = client.via === 'relay' ? relay.x : server.x;
          const targetY = client.via === 'relay' ? relay.y : server.y;
          const color = statusStroke[client.status];

          let lineClass = 'line-active';
          let strokeWidth = 1.5;

          if (client.status === 'syncing') {
            lineClass = 'line-syncing';
            strokeWidth = 2.5;
          } else if (client.status === 'offline') {
            lineClass = 'line-offline';
            strokeWidth = 1;
          }

          return (
            <line
              key={`conn-${client.id}`}
              x1={targetX}
              y1={targetY}
              x2={pos.x}
              y2={pos.y}
              stroke={color}
              strokeWidth={strokeWidth}
              className={lineClass}
            />
          );
        })}

        {/* Data flow particles along active connections */}
        {clients
          .filter((c) => c.status !== 'offline')
          .map((client) => {
            const pos = NODE_POSITIONS[client.id];
            if (!pos) return null;
            const targetX = client.via === 'relay' ? relay.x : server.x;
            const targetY = client.via === 'relay' ? relay.y : server.y;
            const particleColor =
              client.status === 'syncing' ? '#f59e0b' : '#22c55e';
            const dur = client.status === 'syncing' ? '1.2s' : '2.5s';
            const halfDur = `${Number.parseFloat(dur) / 2}s`;

            return (
              <g key={`particle-${client.id}`}>
                <circle r={2} fill={particleColor} opacity={0.8}>
                  <animateMotion
                    dur={dur}
                    repeatCount="indefinite"
                    path={`M${targetX},${targetY} L${pos.x},${pos.y}`}
                  />
                  <animate
                    attributeName="opacity"
                    values="0;0.8;0.8;0"
                    dur={dur}
                    repeatCount="indefinite"
                  />
                </circle>
                <circle r={2} fill={particleColor} opacity={0.6}>
                  <animateMotion
                    dur={dur}
                    begin={halfDur}
                    repeatCount="indefinite"
                    path={`M${pos.x},${pos.y} L${targetX},${targetY}`}
                  />
                  <animate
                    attributeName="opacity"
                    values="0;0.6;0.6;0"
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
          cx={server.x}
          cy={server.y}
          r={40}
          fill="none"
          stroke="#3b82f6"
          strokeWidth={0.5}
          opacity={0.15}
        >
          <animate
            attributeName="r"
            from="30"
            to="58"
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
          cx={server.x}
          cy={server.y}
          r={40}
          fill="none"
          stroke="#3b82f6"
          strokeWidth={0.5}
          opacity={0.15}
        >
          <animate
            attributeName="r"
            from="30"
            to="58"
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
          cx={server.x}
          cy={server.y}
          r={30}
          fill="#0c0c0c"
          stroke="#3b82f6"
          strokeWidth={2}
          style={{
            filter: 'drop-shadow(0 0 10px rgba(59,130,246,0.4))',
          }}
        />
        <circle
          cx={server.x}
          cy={server.y}
          r={16}
          fill="rgba(59,130,246,0.15)"
          stroke="#3b82f6"
          strokeWidth={1}
        />
        <circle cx={server.x} cy={server.y} r={5} fill="#3b82f6" />
        <text
          x={server.x}
          y={server.y + 46}
          textAnchor="middle"
          fill="#555"
          fontFamily="JetBrains Mono"
          fontSize={9}
          letterSpacing={2}
        >
          SERVER
        </text>

        {/* Relay node with pulse ring */}
        <circle
          cx={relay.x}
          cy={relay.y}
          r={35}
          fill="none"
          stroke="#8b5cf6"
          strokeWidth={0.5}
          opacity={0.15}
        >
          <animate
            attributeName="r"
            from="24"
            to="48"
            dur="3.5s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            from="0.25"
            to="0"
            dur="3.5s"
            repeatCount="indefinite"
          />
        </circle>
        <circle
          cx={relay.x}
          cy={relay.y}
          r={24}
          fill="#0c0c0c"
          stroke="#8b5cf6"
          strokeWidth={2}
          style={{
            filter: 'drop-shadow(0 0 8px rgba(139,92,246,0.35))',
          }}
        />
        <circle
          cx={relay.x}
          cy={relay.y}
          r={12}
          fill="rgba(139,92,246,0.15)"
          stroke="#8b5cf6"
          strokeWidth={1}
        />
        <circle cx={relay.x} cy={relay.y} r={4} fill="#8b5cf6" />
        <text
          x={relay.x}
          y={relay.y + 40}
          textAnchor="middle"
          fill="#555"
          fontFamily="JetBrains Mono"
          fontSize={9}
          letterSpacing={2}
        >
          RELAY
        </text>

        {/* Client nodes */}
        {clients.map((client) => {
          const pos = NODE_POSITIONS[client.id];
          if (!pos) return null;
          const fillColor = statusStroke[client.status];
          const ringOpacity = client.status === 'offline' ? 0.3 : 1;

          return (
            <g key={client.id} opacity={ringOpacity}>
              <circle
                cx={pos.x}
                cy={pos.y}
                r={18}
                fill="#0c0c0c"
                stroke={fillColor}
                strokeWidth={1.5}
              />
              <circle cx={pos.x} cy={pos.y} r={4} fill={fillColor} />
              <text
                x={pos.x}
                y={pos.y + 28}
                textAnchor="middle"
                fill="#444"
                fontFamily="JetBrains Mono"
                fontSize={8}
              >
                {client.id}
              </text>
              <text
                x={pos.x}
                y={pos.y + 38}
                textAnchor="middle"
                fill="#333"
                fontFamily="JetBrains Mono"
                fontSize={7}
              >
                {client.type}
                {client.via === 'relay' ? ' \u00b7 relay' : ''}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
});
