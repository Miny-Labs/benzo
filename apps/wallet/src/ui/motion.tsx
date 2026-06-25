/**
 * Motion vocabulary for the wallet — one easing, one rhythm, everywhere. Built on
 * framer-motion so screens compose `fadeUp`/`stagger` instead of re-deriving
 * springs. Respects prefers-reduced-motion (framer reads it globally via
 * MotionConfig in main.tsx; these variants also collapse to no-transform).
 */
import { motion, type Variants, type Transition } from "framer-motion";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

export const EASE = [0.22, 1, 0.36, 1] as const; // the signature ease-out
export const spring: Transition = { type: "spring", stiffness: 420, damping: 32, mass: 0.8 };

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 28 },
  show: (i = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, ease: EASE, delay: (i as number) * 0.08 },
  }),
};

export const popIn: Variants = {
  hidden: { opacity: 0, scale: 0.92 },
  show: { opacity: 1, scale: 1, transition: spring },
};

/** A staggered container: children with `variants={fadeUp}` cascade in order. */
export const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08, delayChildren: 0.02 } },
};

/** Fade/slide a screen in on mount. Use as the outer wrapper of every route. */
export function Screen({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.32, ease: EASE }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** A cascading list/section: wrap items in <Stagger.Item>. */
export function Stagger({ children, className = "", ...props }: { children: ReactNode; className?: string } & ComponentPropsWithoutRef<typeof motion.div>) {
  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className={className} {...props}>
      {children}
    </motion.div>
  );
}
Stagger.Item = function Item({
  children,
  index = 0,
  className = "",
}: {
  children: ReactNode;
  index?: number;
  className?: string;
}) {
  return (
    <motion.div variants={fadeUp} custom={index} className={className}>
      {children}
    </motion.div>
  );
};

export { motion };
