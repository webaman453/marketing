import { BRAND } from "@ashniva/shared";
import type { Metadata } from "next";
import { LegalPage } from "@/components/marketing/legal-page";

export const metadata: Metadata = { title: "Privacy policy" };

// Draft policy: have it reviewed by legal counsel before launch.
export default function PrivacyPage() {
  const email = BRAND.supportEmail;
  return (
    <LegalPage title="Privacy policy" updated="7 October 2026">
      <section>
        <p>
          This policy explains what information {BRAND.name} (“we”, “us”), operated by {BRAND.company}, collects when you
          use our website and application, how we use it, and the choices you have.
        </p>
      </section>

      <section>
        <h2>Information we collect</h2>
        <ul>
          <li>
            <strong>Account information:</strong> your name, work email address, company name and an encrypted hash of
            your password.
          </li>
          <li>
            <strong>Advertising platform data:</strong> when you connect an ad platform such as Meta or Google Ads, we
            receive an access token and read your ad account names, campaign, ad group and ad settings, and performance
            metrics (impressions, clicks, spend, conversions and conversion value).
          </li>
          <li>
            <strong>Usage information:</strong> actions you take in the product (for example, pausing a campaign) are
            recorded in your organization&apos;s activity log, along with the IP address of the request.
          </li>
        </ul>
      </section>

      <section>
        <h2>How we use information</h2>
        <ul>
          <li>To show your advertising performance in one dashboard and to carry out changes you request, such as updating a budget.</li>
          <li>To provide account security, prevent abuse and keep an audit trail for your organization.</li>
          <li>To send service emails such as invitations and password resets.</li>
        </ul>
        <p>
          We do not sell your data, use your advertising data to target ads, or share it with other customers. Data from
          ad platforms is used only to provide the service to the organization that connected it.
        </p>
      </section>

      <section>
        <h2>How we protect information</h2>
        <p>
          Platform access tokens are encrypted at rest using AES-256-GCM. Access to your organization&apos;s data is
          limited to its members according to the roles your administrators assign. All traffic is served over HTTPS.
        </p>
      </section>

      <section>
        <h2>Sharing</h2>
        <p>
          We share information only with service providers that help us run the product (such as cloud hosting and email
          delivery), under agreements that require them to protect it, or when required by law.
        </p>
      </section>

      <section>
        <h2>Retention</h2>
        <p>
          We keep your data while your account is active. When you disconnect an ad platform, its synced data is deleted
          from our systems. When you delete your organization, all of its data is deleted within 30 days.
        </p>
      </section>

      <section>
        <h2 id="data-deletion">Data deletion requests</h2>
        <p>
          You can remove an ad platform&apos;s data at any time from <strong>Integrations → Disconnect</strong>. You can
          also revoke our access directly in your Meta or Google account settings. To delete your account and all
          associated data, email <a href={`mailto:${email}`}>{email}</a> from your account email address and we will
          complete the request within 30 days.
        </p>
      </section>

      <section>
        <h2>Your rights</h2>
        <p>
          Depending on where you live, you may have the right to access, correct, export or delete your personal
          information. Contact us at <a href={`mailto:${email}`}>{email}</a> to make a request.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          Questions about this policy can be sent to <a href={`mailto:${email}`}>{email}</a>.
        </p>
      </section>
    </LegalPage>
  );
}
