import type { ReactNode } from 'react';

type CommandesLayoutProps = {
  children: ReactNode;
  modal: ReactNode;
};

export default function CommandesLayout({ children, modal }: CommandesLayoutProps) {
  return (
    <>
      {children}
      {modal}
    </>
  );
}
