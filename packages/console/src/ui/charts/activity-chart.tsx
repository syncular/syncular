'use client';

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from './chart';

export interface ActivityChartDataPoint {
  timestamp: string;
  pushCount: number;
  pullCount: number;
}

export interface ActivityChartProps {
  data: ActivityChartDataPoint[];
  className?: string;
}

const chartConfig = {
  pushCount: {
    label: 'Push',
    color: 'var(--color-healthy)',
  },
  pullCount: {
    label: 'Pull',
    color: 'var(--color-flow)',
  },
} satisfies ChartConfig;

export function ActivityChart({ data, className }: ActivityChartProps) {
  const formattedData = data.map((bucket) => ({
    ...bucket,
    time: formatTimestamp(bucket.timestamp),
  }));

  return (
    <ChartContainer config={chartConfig} className={className}>
      <AreaChart data={formattedData} margin={{ left: 0, right: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="time"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          fontSize={12}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          fontSize={12}
          width={40}
        />
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent indicator="dot" />}
        />
        <Area
          dataKey="pullCount"
          type="monotone"
          fill="var(--color-flow)"
          fillOpacity={0.3}
          stroke="var(--color-flow)"
          stackId="a"
        />
        <Area
          dataKey="pushCount"
          type="monotone"
          fill="var(--color-healthy)"
          fillOpacity={0.3}
          stroke="var(--color-healthy)"
          stackId="a"
        />
      </AreaChart>
    </ChartContainer>
  );
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
