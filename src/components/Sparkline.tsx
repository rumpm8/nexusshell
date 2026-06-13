interface Props {
  data: number[];
  width?: number;
  height?: number;
  stroke?: string;
}

export default function Sparkline({ data, width = 110, height = 28, stroke = "#b18aff" }: Props) {
  if (data.length < 2) {
    return <svg width={width} height={height} className="sparkline" />;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * (width - 2) + 1;
      const y = height - 2 - ((v - min) / span) * (height - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} className="sparkline">
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth="1.5" />
    </svg>
  );
}
