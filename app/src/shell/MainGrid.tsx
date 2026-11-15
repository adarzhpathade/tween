import React, { forwardRef } from "react";
import { motion, type HTMLMotionProps } from "motion/react";
import type { Screen } from "./types";
import { prefersReducedMotion, tokens, withReducedMotion } from "../motion";

export interface MainGridProps extends HTMLMotionProps<"main"> {
  screen: Screen;
  children: React.ReactNode;
}

export const MainGrid = forwardRef<HTMLElement, MainGridProps>(
  ({ screen, children, ...props }, ref) => {
    const reduced = prefersReducedMotion();

    return (
      <motion.main
        ref={ref}
        className="body"
        data-state={screen}
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.998 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.998 }}
        transition={withReducedMotion(tokens.spring.smooth)}
        {...props}
      >
        {children}
      </motion.main>
    );
  },
);

MainGrid.displayName = "MainGrid";
