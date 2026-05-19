declare module "lucide-react/dist/esm/icons/*.js" {
  import type { ForwardRefExoticComponent, RefAttributes, SVGProps } from "react";

  type IconProps = Omit<SVGProps<SVGSVGElement>, "ref"> & {
    absoluteStrokeWidth?: boolean;
    size?: number | string;
  };

  const Icon: ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>;

  export default Icon;
}
