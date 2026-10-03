import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import * as Primitive from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";

export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;
export const DropdownMenuGroup = Primitive.Group;

export const DropdownMenuContent = forwardRef<
  ElementRef<typeof Primitive.Content>,
  ComponentPropsWithoutRef<typeof Primitive.Content>
>(({ className, sideOffset = 8, ...props }, ref) => (
  <Primitive.Portal>
    <Primitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 min-w-56 rounded-xl border border-line bg-elevated p-1.5 text-sm text-fg shadow-pop",
        className,
      )}
      {...props}
    />
  </Primitive.Portal>
));
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuItem = forwardRef<
  ElementRef<typeof Primitive.Item>,
  ComponentPropsWithoutRef<typeof Primitive.Item>
>(({ className, ...props }, ref) => (
  <Primitive.Item
    ref={ref}
    className={cn(
      "flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-muted outline-none select-none data-disabled:opacity-50 data-highlighted:bg-surface-hover data-highlighted:text-fg [&_svg]:size-4 [&_svg]:shrink-0",
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = "DropdownMenuItem";

export const DropdownMenuLabel = forwardRef<
  ElementRef<typeof Primitive.Label>,
  ComponentPropsWithoutRef<typeof Primitive.Label>
>(({ className, ...props }, ref) => (
  <Primitive.Label
    ref={ref}
    className={cn("px-2.5 py-1.5 text-xs font-medium text-subtle", className)}
    {...props}
  />
));
DropdownMenuLabel.displayName = "DropdownMenuLabel";

export const DropdownMenuSeparator = forwardRef<
  ElementRef<typeof Primitive.Separator>,
  ComponentPropsWithoutRef<typeof Primitive.Separator>
>(({ className, ...props }, ref) => (
  <Primitive.Separator ref={ref} className={cn("my-1.5 h-px bg-line", className)} {...props} />
));
DropdownMenuSeparator.displayName = "DropdownMenuSeparator";

export const DropdownMenuCheckboxItem = forwardRef<
  ElementRef<typeof Primitive.CheckboxItem>,
  ComponentPropsWithoutRef<typeof Primitive.CheckboxItem>
>(({ className, children, ...props }, ref) => (
  <Primitive.CheckboxItem
    ref={ref}
    className={cn(
      "flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-muted outline-none select-none data-highlighted:bg-surface-hover data-highlighted:text-fg data-[state=checked]:text-fg",
      className,
    )}
    {...props}
  >
    <span className="grid size-4 shrink-0 place-items-center rounded border border-line-strong">
      <Primitive.ItemIndicator>
        <span className="block size-2 rounded-sm bg-accent" />
      </Primitive.ItemIndicator>
    </span>
    {children}
  </Primitive.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = "DropdownMenuCheckboxItem";
