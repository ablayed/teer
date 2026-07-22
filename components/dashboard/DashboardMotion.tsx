'use client';

import { MotionConfig, motion, useReducedMotion } from 'framer-motion';
import type { Variants } from 'framer-motion';
import React from 'react';

type DashboardMotionProps = {
  children: React.ReactNode;
};

const containerVariants: Variants = {
  visible: {
    transition: {
      staggerChildren: 0.07,
    },
  },
};

const itemVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: {
    opacity: 1,
    transition: {
      duration: 0.34,
      ease: [0.2, 0, 0, 1] as const,
    },
    y: 0,
  },
};

export function DashboardMotion({ children }: DashboardMotionProps) {
  const reduceMotion = useReducedMotion();

  return (
    <MotionConfig reducedMotion="user">
      <motion.div
        animate="visible"
        className="space-y-8"
        initial={reduceMotion ? false : 'hidden'}
        variants={containerVariants}
      >
        {React.Children.map(children, (child, index) => (
          <motion.div custom={index} variants={itemVariants}>
            {child}
          </motion.div>
        ))}
      </motion.div>
    </MotionConfig>
  );
}
