import { redirect } from 'next/navigation';

/** Legacy path — Route module lives at /route. */
export default function TextRedirectPage() {
  redirect('/route');
}
