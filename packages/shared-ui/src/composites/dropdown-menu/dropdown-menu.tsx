import { forwardRef } from "react";
import * as RadixDropdownMenu from "@radix-ui/react-dropdown-menu";
import { cn } from "../../utils/cn";
import s from "./dropdown-menu.module.css";

export const Root = RadixDropdownMenu.Root;
export const Trigger = RadixDropdownMenu.Trigger;
export const Portal = RadixDropdownMenu.Portal;
export const Group = RadixDropdownMenu.Group;
export const Label = RadixDropdownMenu.Label;
export const Item = RadixDropdownMenu.Item;
export const CheckboxItem = RadixDropdownMenu.CheckboxItem;
export const RadioGroup = RadixDropdownMenu.RadioGroup;
export const RadioItem = RadixDropdownMenu.RadioItem;
export const ItemIndicator = RadixDropdownMenu.ItemIndicator;
export const Separator = RadixDropdownMenu.Separator;
export const Sub = RadixDropdownMenu.Sub;
export const SubTrigger = RadixDropdownMenu.SubTrigger;
export const SubContent = RadixDropdownMenu.SubContent;

type ContentProps = React.ComponentPropsWithoutRef<typeof RadixDropdownMenu.Content>;
export const Content = forwardRef<HTMLDivElement, ContentProps>(
  ({ className, sideOffset = 6, collisionPadding = 8, ...rest }, ref) => (
    <RadixDropdownMenu.Content
      ref={ref}
      className={cn(s.content, className)}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      {...rest}
    />
  ),
);
Content.displayName = "HermesDropdownMenu.Content";

type ArrowProps = React.ComponentPropsWithoutRef<typeof RadixDropdownMenu.Arrow>;
export const Arrow = forwardRef<SVGSVGElement, ArrowProps>(
  ({ className, ...rest }, ref) => (
    <RadixDropdownMenu.Arrow ref={ref} className={cn(s.arrow, className)} {...rest} />
  ),
);
Arrow.displayName = "HermesDropdownMenu.Arrow";
