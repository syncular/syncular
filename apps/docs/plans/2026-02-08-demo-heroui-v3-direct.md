# Demo App: Replace @syncular/hero-ui with Direct HeroUI v3

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove all `@syncular/hero-ui` imports from the demo app and use `@heroui/react` directly, making the demo look polished with proper HeroUI v3 compound components.

**Architecture:** Each demo component file gets rewritten to import from `@heroui/react` instead of `@syncular/hero-ui`. Domain-specific wrappers (SectionCard, PanelShell, SyncStateBadge, SyncularBrand, ToggleGroup) are inlined using HeroUI v3 primitives. The demo CSS is simplified to just import tailwindcss + @heroui/styles.

**Tech Stack:** React 19, HeroUI v3 beta (`@heroui/react@3.0.0-beta.6`), Tailwind CSS v4

---

## HeroUI v3 API Quick Reference

All imports from `@heroui/react`. v3 uses compound component patterns.

### Button
```tsx
<Button variant="primary|secondary|tertiary|outline|ghost|danger|danger-soft" size="sm|md|lg" isIconOnly isDisabled onPress={fn}>
  children
</Button>
```
- No `type` prop, no `disabled` prop, no `title` prop, no `onClick` prop
- Use `isDisabled` instead of `disabled`
- Use `onPress` instead of `onClick`
- For `title`, use `aria-label` or wrap in `<Tooltip>`
- For `type="submit"`, the RAC Button supports `type` prop

### Checkbox
```tsx
<Checkbox isSelected={bool} onChange={fn} isDisabled={bool}>
  <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
  <Label className="text-sm">label</Label>
</Checkbox>
```

### Input
```tsx
<Input placeholder="" value="" onChange={fn} disabled={bool} className="" />
```
- Standard HTML input props (NOT react-aria, uses `disabled` not `isDisabled`)

### Alert
```tsx
<Alert status="default|success|warning|danger|accent">
  <Alert.Content>
    <Alert.Title>title</Alert.Title>
    <Alert.Description>description</Alert.Description>
  </Alert.Content>
</Alert>
```

### Card
```tsx
<Card variant="default|secondary|tertiary|transparent">
  <Card.Header>
    <Card.Title>title</Card.Title>
    <Card.Description>desc</Card.Description>
  </Card.Header>
  <Card.Content>content</Card.Content>
  <Card.Footer>footer</Card.Footer>
</Card>
```

### Chip (replaces Badge)
```tsx
<Chip color="default|accent|success|warning|danger" variant="primary|secondary|tertiary|soft" size="sm|md|lg">
  text or <Chip.Label>text</Chip.Label>
</Chip>
```

### Select
```tsx
import { Select, ListBoxItem } from '@heroui/react';

<Select selectedKey={value} onSelectionChange={fn}>
  <Select.Trigger><Select.Value /></Select.Trigger>
  <Select.Popover>
    <ListBoxItem id="val" textValue="label">label</ListBoxItem>
  </Select.Popover>
</Select>
```

### Separator
```tsx
<Separator orientation="horizontal|vertical" />
```

### Spinner
```tsx
<Spinner size="sm|md|lg|xl" color="current|accent|success|warning|danger" />
```

### Tabs (replaces ToggleGroup for navigation)
```tsx
<Tabs selectedKey={key} onSelectionChange={fn}>
  <Tabs.ListContainer>
    <Tabs.List aria-label="label">
      <Tabs.Tab id="key1">Label 1<Tabs.Indicator /></Tabs.Tab>
      <Tabs.Tab id="key2">Label 2<Tabs.Indicator /></Tabs.Tab>
    </Tabs.List>
  </Tabs.ListContainer>
  <Tabs.Panel id="key1">content</Tabs.Panel>
  <Tabs.Panel id="key2">content</Tabs.Panel>
</Tabs>
```

### TextArea
```tsx
<TextArea placeholder="" value="" onChange={fn} rows={4} />
```

### TextField (Label + Input + Description composed)
```tsx
<TextField>
  <Label>label</Label>
  <Input placeholder="" />
  <Description>help text</Description>
</TextField>
```

### Label
```tsx
<Label htmlFor="id">text</Label>
```

### Description
```tsx
<Description>help text</Description>
```

### Surface (card-like container)
```tsx
<Surface variant="default|secondary|tertiary|transparent" className="rounded-2xl p-6">
  content
</Surface>
```

### Tooltip
```tsx
<Tooltip delay={0}>
  <Button>trigger</Button>
  <Tooltip.Content>content</Tooltip.Content>
</Tooltip>
```

---

## Component Mapping: @syncular/hero-ui → @heroui/react

| Old Import | New Import / Approach |
|---|---|
| `Button` | `Button` from `@heroui/react` — variant: default→primary, outline→outline, secondary→secondary, ghost→ghost, destructive→danger, link→tertiary. Size: default/sm→sm, lg→md, icon-*→sm+isIconOnly. `disabled`→`isDisabled`, `onClick`→`onPress`, remove `type="button"` |
| `Badge` | `Chip` from `@heroui/react` — variant: default→secondary, destructive→soft+danger, outline→tertiary |
| `Alert`, `AlertDescription` | `Alert` from `@heroui/react` — compound: Alert > Alert.Content > Alert.Description |
| `Card`, `CardContent` | `Card` from `@heroui/react` — compound: Card > Card.Content |
| `Checkbox` | `Checkbox`, `Label` from `@heroui/react` — compound pattern |
| `Input` | `Input` from `@heroui/react` |
| `Textarea` | `TextArea` from `@heroui/react` (capital A) |
| `Select`, `SelectTrigger`, `SelectContent`, `SelectItem`, `SelectValue` | `Select`, `ListBoxItem` from `@heroui/react` — compound |
| `Separator` | `Separator` from `@heroui/react` |
| `Field`, `FieldLabel`, `FieldDescription` | `TextField`, `Label`, `Description` from `@heroui/react` |
| `SectionCard` | Inline with `Card` compound + header div |
| `PanelShell` | Inline with `Card` compound + header div |
| `SyncStateBadge` | Inline logic with `Chip` |
| `SyncularBrand` | Inline the JSX directly (just a styled span) |
| `ToggleGroup`, `ToggleGroupItem` | `Tabs` from `@heroui/react` |

---

## Tasks

### Task 1: Update package.json and CSS

**Files:**
- Modify: `demo/package.json` — remove `@syncular/hero-ui` dep, add `@heroui/react`
- Modify: `demo/styles/globals.css` — remove hero-ui token import and @source
- Modify: `demo/src/index.css` — keep as is (imports globals.css)

**Step 1: Update package.json**

Remove `"@syncular/hero-ui": "workspace:*"` from dependencies. Add `"@heroui/react": "3.0.0-beta.6"` if not already present (it may already be installed transitively).

Run: `cd /Users/bkniffler/GitHub/sync && bun install @heroui/react --cwd demo`

**Step 2: Update globals.css**

Replace contents with:
```css
@import "tailwindcss";
@import "@heroui/styles";

body {
  font-family: system-ui, sans-serif;
}

.font-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
```

**Step 3: Update build script**

In `demo/package.json`, remove the `bun --cwd ../packages/hero-ui build &&` prefix from the `build` script.

---

### Task 2: Rewrite SyncStatusBadge.tsx and SyncControls.tsx

**Files:**
- Modify: `demo/src/components/SyncStatusBadge.tsx`
- Modify: `demo/src/components/SyncControls.tsx`

**SyncStatusBadge.tsx** — inline the sync state resolution logic, use `Chip` directly:
```tsx
import { Chip } from '@heroui/react';
import { useSyncState, useSyncEngine } from '@syncular/client-react';

// Keep the same sync state resolution logic from the old SyncStateBadge
// but render as a Chip with appropriate color/variant
```

**SyncControls.tsx** — replace `Button` and `SyncStateBadge` with HeroUI equivalents:
- `Button` → `@heroui/react` Button with `variant`/`isDisabled`/`onPress` props
- Inline the SyncStateBadge chip

---

### Task 3: Rewrite App.tsx

**Files:**
- Modify: `demo/src/components/App.tsx`

Replace:
- `Button` → `@heroui/react` Button
- `SyncularBrand` → inline span markup
- `ToggleGroup`/`ToggleGroupItem` → `Tabs` compound component from `@heroui/react`

The top nav demo selection should use Tabs instead of ToggleGroup for proper navigation feel.

---

### Task 4: Rewrite TaskList.tsx

**Files:**
- Modify: `demo/src/components/TaskList.tsx`

Replace:
- `Button` → `@heroui/react` Button (`disabled`→`isDisabled`, `onClick`→`onPress`, remove `type="button"`, `title`→`aria-label`)
- `Checkbox` → `@heroui/react` Checkbox compound component
- `Input` → `@heroui/react` Input

Key changes:
- `<Checkbox checked={bool} onCheckedChange={fn} disabled={bool}>` → `<Checkbox isSelected={bool} onChange={fn} isDisabled={bool}><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control></Checkbox>`
- File input stays as native `<input type="file">` (not a HeroUI Input)
- Form submit button uses `type="submit"` on Button

---

### Task 5: Rewrite ConflictList.tsx

**Files:**
- Modify: `demo/src/components/ConflictList.tsx`

Replace:
- `Badge` → `Chip` from `@heroui/react`
- `Button` → `@heroui/react` Button
- `Card`/`CardContent` → `@heroui/react` Card compound
- `SectionCard` → inline with Card + header layout

---

### Task 6: Rewrite PatientNoteList.tsx

**Files:**
- Modify: `demo/src/components/PatientNoteList.tsx`

Replace:
- `Alert`/`AlertDescription` → `@heroui/react` Alert compound
- `Badge` → `Chip`
- `Button` → `@heroui/react` Button
- `Card`/`CardContent` → `@heroui/react` Card compound
- `Textarea` → `TextArea` from `@heroui/react`

---

### Task 7: Rewrite SharedTaskList.tsx

**Files:**
- Modify: `demo/src/components/SharedTaskList.tsx`

Replace:
- `Alert`/`AlertDescription` → `@heroui/react` Alert compound
- `Button` → `@heroui/react` Button
- `Checkbox` → `@heroui/react` Checkbox compound
- `Input` → `@heroui/react` Input

---

### Task 8: Rewrite SymmetricPanel.tsx

**Files:**
- Modify: `demo/src/components/SymmetricPanel.tsx`

Replace:
- `Alert`/`AlertDescription` → `@heroui/react` Alert compound
- `Button` → `@heroui/react` Button
- `Field`/`FieldLabel`/`FieldDescription` → `TextField`/`Label`/`Description` from `@heroui/react`
- `Input` → `@heroui/react` Input
- `PanelShell` → inline with Card compound (Card > Card.Header with title/subtitle/status > Card.Content)
- `Select`/`SelectTrigger`/`SelectContent`/`SelectItem`/`SelectValue` → `Select`/`ListBoxItem` compound from `@heroui/react`
- `Separator` → `@heroui/react` Separator

---

### Task 9: Rewrite KeyShareDemo.tsx and KeySharePanel.tsx

**Files:**
- Modify: `demo/src/components/KeyShareDemo.tsx`
- Modify: `demo/src/components/KeySharePanel.tsx`

**KeyShareDemo.tsx:**
- `Button` → `@heroui/react` Button
- `SectionCard` → inline with Card compound
- `Textarea` → `TextArea`
- `ToggleGroup`/`ToggleGroupItem` → `Tabs` compound

**KeySharePanel.tsx:**
- `Alert`/`AlertDescription` → `@heroui/react` Alert compound
- `PanelShell` → inline with Card compound

---

### Task 10: Rewrite SyncPanel.tsx, SplitScreenDemo.tsx, SymmetricDemo.tsx

**Files:**
- Modify: `demo/src/components/SyncPanel.tsx`
- Modify: `demo/src/components/SplitScreenDemo.tsx`
- Modify: `demo/src/components/SymmetricDemo.tsx`

**SyncPanel.tsx:**
- `PanelShell` → inline with Card compound

**SplitScreenDemo.tsx:**
- `SectionCard` → inline with Card compound

**SymmetricDemo.tsx:**
- `SectionCard` → inline with Card compound

---

### Task 11: Rewrite LargeCatalogDemo.tsx

**Files:**
- Modify: `demo/src/components/LargeCatalogDemo.tsx`

Replace:
- `Alert`/`AlertDescription` → `@heroui/react` Alert compound
- `Button` → `@heroui/react` Button
- `Card`/`CardContent` → `@heroui/react` Card compound
- `Input` → `@heroui/react` Input
- `PanelShell` → inline with Card compound
- `Checkbox` → `@heroui/react` Checkbox (if present)

---

### Task 12: Type check and verify

**Step 1:** Run `bun check:fix` to verify no type errors
**Step 2:** Fix any remaining type errors
**Step 3:** Run `bun --cwd demo dev` and visually verify the demo looks good

---

## Inlined Component Patterns

### SectionCard → Card compound
```tsx
// OLD:
<SectionCard title="Title" description="desc" actions={<Button>action</Button>}>
  content
</SectionCard>

// NEW:
<Card>
  <Card.Header>
    <div className="flex items-start justify-between">
      <div>
        <Card.Title>Title</Card.Title>
        <Card.Description>desc</Card.Description>
      </div>
      <div className="flex items-center gap-2"><Button>action</Button></div>
    </div>
  </Card.Header>
  <Card.Content>content</Card.Content>
</Card>
```

### PanelShell → Card compound
```tsx
// OLD:
<PanelShell title="Title" subtitle="sub" status={<Badge>Online</Badge>}>
  content
</PanelShell>

// NEW:
<Card>
  <Card.Header>
    <div className="flex items-start justify-between">
      <div>
        <Card.Title>Title</Card.Title>
        <Card.Description>sub</Card.Description>
      </div>
      <div className="flex items-center gap-2"><Chip>Online</Chip></div>
    </div>
  </Card.Header>
  <Card.Content className="p-6">content</Card.Content>
</Card>
```

### SyncStateBadge → inline Chip
```tsx
// Inline the resolve function, render as:
<Chip color={chipColor} variant="soft" size="sm">{label}</Chip>
```

### SyncularBrand → inline span
```tsx
<span className="flex items-center gap-3">
  <span className="text-sm font-bold tracking-tight text-white">syncular</span>
  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" style={{ boxShadow: '0 0 6px #22c55e' }} />
  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-emerald-500/70">operational</span>
</span>
```
