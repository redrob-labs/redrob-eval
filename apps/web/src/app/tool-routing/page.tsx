import { redirect } from 'next/navigation';

/** Old top-level Router route; tool routing is now a task inside Compare. */
export default function ToolRoutingRedirectPage() {
  redirect('/compare');
}
