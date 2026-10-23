import { Link } from "react-router";

export const LandingPage = () => {
  return (
    <main className="grid h-dvh place-items-center p-6">
      <Link className="primary-link" to="/dress">
        Get started
      </Link>
    </main>
  );
};
