'use client';

import { Cell, Pie, PieChart } from 'recharts';
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from './chart';

export interface OutcomesChartDataPoint {
  pushCount: number;
  pullCount: number;
  errorCount: number;
}

export interface OutcomesChartProps {
  data: OutcomesChartDataPoint[];
  className?: string;
}

const chartConfig = {
  success: {
    label: 'Success',
    color: 'var(--color-healthy)',
  },
  errors: {
    label: 'Errors',
    color: 'var(--color-offline)',
  },
} satisfies ChartConfig;

export function OutcomesChart({ data, className }: OutcomesChartProps) {
  const totalOperations = data.reduce(
    (sum, bucket) => sum + bucket.pushCount + bucket.pullCount,
    0
  );
  const totalErrors = data.reduce((sum, bucket) => sum + bucket.errorCount, 0);
  const successCount = totalOperations - totalErrors;

  const chartData = [
    { name: 'Success', value: successCount, fill: 'var(--color-healthy)' },
    { name: 'Errors', value: totalErrors, fill: 'var(--color-offline)' },
  ].filter((item) => item.value > 0);

  if (chartData.length === 0) {
    chartData.push({
      name: 'No data',
      value: 1,
      fill: 'var(--color-neutral-700)',
    });
  }

  const errorRate =
    totalOperations > 0
      ? ((totalErrors / totalOperations) * 100).toFixed(1)
      : '0';

  return (
    <ChartContainer config={chartConfig} className={className}>
      <PieChart>
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent hideLabel />}
        />
        <Pie
          data={chartData}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          innerRadius={60}
          outerRadius={80}
          paddingAngle={2}
        >
          {chartData.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={entry.fill} />
          ))}
        </Pie>
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-foreground text-2xl font-bold"
        >
          {errorRate}%
        </text>
        <text
          x="50%"
          y="58%"
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-neutral-500 text-xs"
        >
          error rate
        </text>
      </PieChart>
    </ChartContainer>
  );
}
