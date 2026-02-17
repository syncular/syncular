'use client';

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from './chart';

export interface LatencyPercentiles {
  p50: number;
  p90: number;
  p99: number;
}

export interface LatencyChartData {
  push: LatencyPercentiles;
  pull: LatencyPercentiles;
}

export interface LatencyChartProps {
  data: LatencyChartData;
  className?: string;
}

const chartConfig = {
  push: {
    label: 'Push',
    color: 'var(--color-healthy)',
  },
  pull: {
    label: 'Pull',
    color: 'var(--color-flow)',
  },
} satisfies ChartConfig;

export function LatencyChart({ data, className }: LatencyChartProps) {
  const chartData = [
    { percentile: 'p50', push: data.push.p50, pull: data.pull.p50 },
    { percentile: 'p90', push: data.push.p90, pull: data.pull.p90 },
    { percentile: 'p99', push: data.push.p99, pull: data.pull.p99 },
  ];

  return (
    <ChartContainer config={chartConfig} className={className}>
      <BarChart data={chartData} margin={{ left: 0, right: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="percentile"
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
          width={50}
          tickFormatter={(value) => `${value}ms`}
        />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              formatter={(value, name) => [`${value}ms`, name]}
            />
          }
        />
        <Bar dataKey="push" fill="var(--color-healthy)" radius={[4, 4, 0, 0]} />
        <Bar dataKey="pull" fill="var(--color-flow)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ChartContainer>
  );
}
