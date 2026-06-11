import { RouterProvider } from "react-router-dom";

import { routes } from "@/app/routes";

export default function App() {
  return <RouterProvider router={routes} />;
}
