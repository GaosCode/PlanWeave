const avatarColors = [
  "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200",
  "bg-violet-100 text-violet-800 dark:bg-violet-900/50 dark:text-violet-200",
  "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
  "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200",
  "bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200",
  "bg-teal-100 text-teal-800 dark:bg-teal-900/50 dark:text-teal-200"
] as const;

export function MemberAvatar({
  identity,
  initials,
  label
}: {
  identity: string;
  initials: string;
  label: string;
}) {
  let hash = 0;
  for (const character of identity) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return (
    <span
      aria-hidden="true"
      title={label}
      className={`inline-flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${avatarColors[hash % avatarColors.length]}`}
    >
      {initials}
    </span>
  );
}
