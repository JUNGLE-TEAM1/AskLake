declare module "lucide-react/dist/esm/icons/*.mjs" {
  import type { ForwardRefExoticComponent, RefAttributes, SVGProps } from "react";

  type LucideProps = Omit<SVGProps<SVGSVGElement>, "ref"> & {
    absoluteStrokeWidth?: boolean;
    color?: string;
    size?: number | string;
    strokeWidth?: number | string;
  };

  const Icon: ForwardRefExoticComponent<LucideProps & RefAttributes<SVGSVGElement>>;
  export default Icon;
}
