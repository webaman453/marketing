import { BRAND } from "@ashniva/shared";
import type { Metadata } from "next";
import { LegalPage } from "@/components/marketing/legal-page";

export const metadata: Metadata = { title: "Terms of service" };

// Draft terms: have them reviewed by legal counsel before launch.
export default function TermsPage() {
  const email = BRAND.supportEmail;
  return (
    <LegalPage title="Terms of service" updated="7 October 2026">
      <section>
        <p>
          These terms govern your use of {BRAND.name}, provided by {BRAND.company}. By creating an account you agree to
          them on behalf of yourself and the organization you represent.
        </p>
      </section>

      <section>
        <h2>The service</h2>
        <p>
          {BRAND.name} lets you connect advertising accounts, view their performance and make changes such as pausing
          campaigns or adjusting budgets. Changes you make are sent to the advertising platform on your behalf.
        </p>
      </section>

      <section>
        <h2>Your responsibilities</h2>
        <ul>
          <li>You must have permission to manage every ad account you connect.</li>
          <li>You are responsible for changes made by members of your organization, and for the resulting ad spend.</li>
          <li>You must comply with the policies of each advertising platform you connect.</li>
          <li>Keep your login credentials secure and tell us promptly about any unauthorized use.</li>
        </ul>
      </section>

      <section>
        <h2>Advertising platforms</h2>
        <p>
          Meta, Google, YouTube and other platforms are independent third parties. Their availability, data accuracy and
          policies are outside our control, and reported figures may differ slightly from those platforms because of
          attribution and reporting delays.
        </p>
      </section>

      <section>
        <h2>Trials, plans and payment</h2>
        <p>
          Accounts created from the sign-up page need a paid plan before the workspace can be changed. Access granted by the platform operator can be free or paid, as the operator decides. Plan limits, such
          as the number of workspaces or ad accounts, apply as described at the time of purchase.
        </p>
      </section>

      <section>
        <h2>Data</h2>
        <p>
          You own your data. We process it only to provide the service, as described in our{" "}
          <a href="/privacy">privacy policy</a>.
        </p>
      </section>

      <section>
        <h2>Termination</h2>
        <p>
          You may stop using the service at any time. We may suspend accounts that violate these terms or the policies of
          connected platforms.
        </p>
      </section>

      <section>
        <h2>Limitation of liability</h2>
        <p>
          The service is provided “as is”. To the extent permitted by law, we are not liable for indirect or
          consequential losses, including lost profits or ad spend resulting from changes made through the service.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          Questions about these terms can be sent to <a href={`mailto:${email}`}>{email}</a>.
        </p>
      </section>
    </LegalPage>
  );
}
