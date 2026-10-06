import Link from 'next/link'
import Header from '@/components/Header.js'
import Footer from '@/components/Footer.js'

// Fully static, like the pricing page. The software terms here match LICENSE at the repo root;
// change both together.
export const metadata = { title: 'Terms of Service' }

const UPDATED = '5 October 2026'

export default function Terms () {
  return (
    <>
      <Header />
      <main className='wrap page legal'>
        <h1>Terms of Service</h1>
        <p className='muted'>Last updated {UPDATED}</p>

        <p>
          These terms are an agreement between you and Quilt (Daniel Carmichael, “Quilt”, “we”, “us”)
          about the Quilt desktop app, command-line tool, website at heyquilt.com, hosted relay, API and
          cloud agents (together, the “Service”). By creating an account, downloading the app or using
          the Service you agree to them. If you use Quilt for a company, you agree on its behalf and
          confirm you can.
        </p>

        <h2>1. Your account</h2>
        <p>
          Keep your sign-in details and the computers linked to your account secure. You are responsible
          for what happens under your account, including what agents you add or invite do. Tell us
          straight away if you think someone else has access. You must be old enough to form a binding
          contract where you live, and at least 16.
        </p>

        <h2>2. Plans and payment</h2>
        <p>
          Quilt offers the plans shown on the <Link href='/pricing'>pricing page</Link>. Paid plans are
          billed in advance for each month or year and renew automatically until you cancel. Cancelling
          stops the next renewal; you keep paid features until the end of the period you paid for. Fees
          are not refundable except where the law requires. We may change prices for a future period
          after giving you notice. Features of a plan are available only while that plan is active.
        </p>

        <h2>3. The software license</h2>
        <p>
          Quilt is proprietary software. Its source code is publicly visible, but it is not open source
          and seeing it gives you no right to use it. We grant you a limited, personal, non-exclusive,
          non-transferable license to install and use the official Quilt app and tools, as we distribute
          them, under the plan you hold and only while you hold it. You may not:
        </p>
        <ul>
          <li>copy, clone, fork or mirror the source code, or modify it or build derivative works from it;</li>
          <li>use the software, or code, designs or ideas taken from it, to build or offer any other product or service, including one that competes with Quilt;</li>
          <li>sell, sublicense, redistribute or host Quilt for others, or run its relay or API servers yourself, except the local sessions the app itself starts on your network;</li>
          <li>bypass or interfere with sign-in, plan limits, payment or any security measure;</li>
          <li>use the software or its source code to train or evaluate machine-learning or AI models.</li>
        </ul>
        <p>
          The full terms are in the <a href='https://github.com/DanielCarmichaelGit/heyquilt/blob/main/LICENSE'>Quilt license</a>.
          Open-source components that Quilt includes stay under their own licenses.
        </p>

        <h2>4. Your content</h2>
        <p>
          Your code, files, messages and tasks stay yours. You give us permission to store, sync and
          transmit them only as needed to run the Service for you and the people you share a session
          with. You are responsible for having the right to share what you put into a session, and for
          what your collaborators and agents can see once you invite them.
        </p>

        <h2>5. Acceptable use</h2>
        <p>
          Do not use the Service to break the law, infringe anyone’s rights, distribute malware, attack
          or overload our systems or anyone else’s, scrape the Service, or get around limits we put in
          place. We may suspend use that puts the Service or other people at risk.
        </p>

        <h2>6. AI tools and agents</h2>
        <p>
          Quilt connects to AI tools you choose, and to cloud agents you add. Those tools act on your
          instructions and can be wrong. Review what they change before you rely on it. Third-party AI
          tools are governed by their own terms.
        </p>

        <h2>7. Ending the agreement</h2>
        <p>
          You can stop using Quilt and delete your account at any time. We may suspend or end your access
          if you break these terms or the license, or if we stop offering the Service, with notice where
          reasonable. When access ends, your license ends and you must delete your copies of the
          software.
        </p>

        <h2>8. Disclaimers</h2>
        <p>
          The Service is provided “as is” and “as available”, without warranties of any kind, to the
          fullest extent the law allows. We do not promise it will be uninterrupted or error-free, or
          that it will never lose data. Keep your own backups, such as a git repository.
        </p>

        <h2>9. Limitation of liability</h2>
        <p>
          To the fullest extent the law allows, Quilt is not liable for indirect, incidental, special,
          consequential or punitive damages, or for lost profits, data or goodwill. Our total liability
          for any claim about the Service is limited to the amount you paid us in the 12 months before
          the claim, or 100 US dollars if that is more.
        </p>

        <h2>10. Changes</h2>
        <p>
          We may update these terms. If a change is material we will tell you by email or in the app
          before it takes effect. Using the Service after that means you accept the new terms.
        </p>

        <h2>11. Contact</h2>
        <p>
          Questions about these terms or licensing: <a href='mailto:hello@heyquilt.com'>hello@heyquilt.com</a>.
        </p>
      </main>
      <Footer />
    </>
  )
}
