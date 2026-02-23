'use client';

import * as React from 'react';
import * as RechartsPrimitive from 'recharts';
import { cn } from '../lib/cn';

const THEMES = { light: '', dark: '.dark' } as const;
type ThemeName = keyof typeof THEMES;

export type ChartConfig = Record<
  string,
  {
    icon?: React.ComponentType;
    label?: React.ReactNode;
  } & (
    | { color?: string; theme?: never }
    | { color?: never; theme: Record<ThemeName, string> }
  )
>;

type ChartContextProps = {
  config: ChartConfig;
};

const ChartContext = React.createContext<ChartContextProps | null>(null);

function useChart() {
  const context = React.useContext(ChartContext);
  if (!context) {
    throw new Error('useChart must be used within a <ChartContainer />');
  }
  return context;
}

export const ChartContainer = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'> & {
    config: ChartConfig;
    children: React.ComponentProps<
      typeof RechartsPrimitive.ResponsiveContainer
    >['children'];
  }
>(({ id, className, children, config, ...props }, ref) => {
  const uniqueId = React.useId();
  const chartId = `chart-${id || uniqueId.replace(/:/g, '')}`;
  return (
    <ChartContext.Provider value={{ config }}>
      <div
        className={cn(
          "flex justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-neutral-500 [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-none [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-panel [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-panel [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-sector]:outline-none [&_.recharts-surface]:outline-none",
          className
        )}
        data-chart={chartId}
        ref={ref}
        {...props}
      >
        <ChartStyle config={config} id={chartId} />
        <RechartsPrimitive.ResponsiveContainer
          initialDimension={{ width: 1, height: 1 }}
        >
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
});
ChartContainer.displayName = 'ChartContainer';

function ChartStyle({ config, id }: { config: ChartConfig; id: string }) {
  const colorConfig = Object.entries(config).filter(
    ([, itemConfig]) => itemConfig.theme || itemConfig.color
  );

  if (colorConfig.length < 1) {
    return null;
  }

  return (
    <style
      // biome-ignore lint/security/noDangerouslySetInnerHtml: Static style generation for chart CSS variables.
      dangerouslySetInnerHTML={{
        __html: Object.entries(THEMES)
          .map(([theme, prefix]) => {
            const variables = colorConfig
              .map(([key, itemConfig]) => {
                const color =
                  itemConfig.theme?.[theme as ThemeName] ?? itemConfig.color;
                return color ? `  --color-${key}: ${color};` : null;
              })
              .filter(Boolean)
              .join('\n');
            return `${prefix} [data-chart='${id}'] {\n${variables}\n}`;
          })
          .join('\n'),
      }}
    />
  );
}

type TooltipPayloadData = {
  fill?: string;
} & Record<string, string | number | boolean | null | undefined>;

interface TooltipPayloadItem {
  color?: string;
  dataKey?: string | number;
  fill?: string;
  name?: string;
  payload?: TooltipPayloadData;
  value?: number | string;
}

export const ChartTooltip = RechartsPrimitive.Tooltip;

interface ChartTooltipContentProps extends React.ComponentProps<'div'> {
  active?: boolean;
  color?: string;
  formatter?: (
    value: string | number,
    name: string,
    item: TooltipPayloadItem,
    index: number,
    payload: TooltipPayloadData
  ) => React.ReactNode;
  hideIndicator?: boolean;
  hideLabel?: boolean;
  indicator?: 'dashed' | 'dot' | 'line';
  label?: string;
  labelClassName?: string;
  labelFormatter?: (
    value: string | React.ReactNode,
    payload: TooltipPayloadItem[]
  ) => React.ReactNode;
  labelKey?: string;
  nameKey?: string;
  payload?: TooltipPayloadItem[];
}

export const ChartTooltipContent = React.forwardRef<
  HTMLDivElement,
  ChartTooltipContentProps
>(
  (
    {
      active,
      className,
      color,
      formatter,
      hideIndicator = false,
      hideLabel = false,
      indicator = 'dot',
      label,
      labelClassName,
      labelFormatter,
      labelKey,
      nameKey,
      payload,
    },
    ref
  ) => {
    const { config } = useChart();

    const tooltipLabel = React.useMemo(() => {
      if (hideLabel || !payload?.length) {
        return null;
      }
      const item = payload[0];
      if (!item) {
        return null;
      }
      const key = `${labelKey || item.dataKey || item.name || 'value'}`;
      const itemConfig = getPayloadConfigFromPayload(config, item, key);
      const value =
        !labelKey && typeof label === 'string'
          ? (config[label]?.label ?? label)
          : itemConfig?.label;

      if (labelFormatter) {
        return (
          <div className={cn('font-medium', labelClassName)}>
            {labelFormatter(value ?? '', payload)}
          </div>
        );
      }
      if (!value) {
        return null;
      }
      return <div className={cn('font-medium', labelClassName)}>{value}</div>;
    }, [
      config,
      hideLabel,
      label,
      labelClassName,
      labelFormatter,
      labelKey,
      payload,
    ]);

    if (!active || !payload?.length) {
      return null;
    }

    const nestLabel = payload.length === 1 && indicator !== 'dot';

    return (
      <div
        className={cn(
          'grid min-w-[8rem] items-start gap-1.5 rounded-lg border border-border/50 bg-surface px-2.5 py-1.5 text-xs shadow-xl',
          className
        )}
        ref={ref}
      >
        {!nestLabel ? tooltipLabel : null}
        <div className="grid gap-1.5">
          {payload.map((item, index) => {
            const key = `${nameKey || item.name || item.dataKey || 'value'}`;
            const itemConfig = getPayloadConfigFromPayload(config, item, key);
            const indicatorColor = color || item.payload?.fill || item.color;

            return (
              <div
                className={cn(
                  'flex w-full flex-wrap items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5 [&>svg]:text-neutral-500',
                  indicator === 'dot' ? 'items-center' : null
                )}
                key={key}
              >
                {formatter && item.value !== undefined && item.name ? (
                  formatter(
                    item.value,
                    item.name,
                    item,
                    index,
                    item.payload ?? {}
                  )
                ) : (
                  <>
                    {itemConfig?.icon ? (
                      <itemConfig.icon />
                    ) : !hideIndicator ? (
                      <div
                        className={cn(
                          'shrink-0 rounded-[2px] border-[--color-border] bg-[--color-bg]',
                          indicator === 'dot' ? 'h-2.5 w-2.5' : null,
                          indicator === 'line' ? 'w-1' : null,
                          indicator === 'dashed'
                            ? 'w-0 border-[1.5px] border-dashed bg-transparent'
                            : null,
                          nestLabel && indicator === 'dashed' ? 'my-0.5' : null
                        )}
                        style={
                          {
                            '--color-bg': indicatorColor,
                            '--color-border': indicatorColor,
                          } as React.CSSProperties
                        }
                      />
                    ) : null}
                    <div
                      className={cn(
                        'flex flex-1 justify-between leading-none',
                        nestLabel ? 'items-end' : 'items-center'
                      )}
                    >
                      <div className="grid gap-1.5">
                        {nestLabel ? tooltipLabel : null}
                        <span className="text-neutral-500">
                          {itemConfig?.label || item.name}
                        </span>
                      </div>
                      {item.value !== undefined ? (
                        <span className="font-mono font-medium tabular-nums text-foreground">
                          {typeof item.value === 'number'
                            ? item.value.toLocaleString()
                            : item.value}
                        </span>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }
);
ChartTooltipContent.displayName = 'ChartTooltipContent';

function getPayloadConfigFromPayload(
  config: ChartConfig,
  item: TooltipPayloadItem,
  key: string
) {
  const payloadValue = item.payload?.[key];
  const payloadKey = typeof payloadValue === 'string' ? payloadValue : null;
  const dataKey = typeof item.dataKey === 'string' ? item.dataKey : null;
  const nameKey = typeof item.name === 'string' ? item.name : null;
  const configKey = payloadKey ?? dataKey ?? nameKey ?? key;
  return config[configKey];
}
