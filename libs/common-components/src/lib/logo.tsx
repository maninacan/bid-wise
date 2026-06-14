interface BidWiseLogoProps {
  onClick?: () => void;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

const SIZES = {
  sm: { icon: 32, text: '1.5rem' },
  md: { icon: 40, text: '2rem' },
  lg: { icon: 48, text: '2.5rem' },
};

export function BidWiseLogo({ onClick, className, size = 'lg' }: BidWiseLogoProps) {
  const { icon, text } = SIZES[size];
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={['flex items-center gap-3', onClick ? 'cursor-pointer' : '', className ?? ''].join(' ').trim()}
    >
      <svg
        width={icon}
        height={icon}
        viewBox="0 0 48 48"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <rect width="48" height="48" rx="12" fill="#2563eb" />
        <path
          d="M13 25.5 L20.5 33 L35 17"
          stroke="white"
          strokeWidth="4.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span style={{ fontSize: text }} className="font-bold tracking-tight text-slate-900">
        Bid<span className="text-blue-600">Wise</span>
      </span>
    </Tag>
  );
}
