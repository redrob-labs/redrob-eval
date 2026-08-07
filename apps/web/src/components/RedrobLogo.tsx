/**
 * Redrob brand mark. Vector path from the brand favicon; uses currentColor so
 * it works on the dark titlebar and on light panels alike.
 */
export function RedrobLogo({
  size = 18,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      role="img"
      aria-label="Redrob"
    >
      <path
        d="M10.392 12.8V8L15.9956 10.0396L16 10.0412V13.0884L7.9996 16.0004L0 13.0884V10.0408L0.0032 10.0396L5.6068 8V11.058L10.392 12.8ZM16 5.9588V2.912L7.9996 0L0 2.9116V5.9592L0.0032 5.9604L5.6068 7.9996V4.952L10.392 3.2104V7.9996L15.9956 5.9604L16 5.9584V5.9588Z"
        fill="currentColor"
      />
    </svg>
  );
}
