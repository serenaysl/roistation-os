import type { Connection, Target, TargetState } from "@/lib/publications";
import type { PublishScope } from "@/lib/publishing/definitions";

/*
 * Publish channels decide the per-site outcome of a publish/withdraw/delete.
 * Today the only channel is the central site feed (widget + connector pages),
 * which needs a verified connection. Future channels (Google Business Profile,
 * Facebook, Instagram, LinkedIn, WordPress, headless CMS, RSS, newsletter) implement
 * the same interface and register in `publishChannels`; each target is
 * evaluated independently, so one failing site/channel never stops the others.
 */

export type ChannelAction = "publish" | "withdraw" | "delete";
export type ChannelOutcome = { siteId: string; success: boolean; status: TargetState; detail: string; skipped?: boolean };
export type ChannelContext = {
  siteId: string;
  action: ChannelAction;
  scheduledAt: string | null;
  scope?: PublishScope;
  /** Existing target when operating on a stored publication; absent for a brand-new one. */
  current?: Target;
  connection?: Connection;
  effectiveStatus?: TargetState;
};
export interface PublishChannel {
  id: string;
  label: string;
  /** Whether this channel needs a verified site connection before publishing. */
  requiresConnection: boolean;
  evaluate(context: ChannelContext): ChannelOutcome;
}

export const siteFeedChannel: PublishChannel = {
  id: "site-feed",
  label: "Site yayın alanı ve SEO sayfaları",
  requiresConnection: true,
  evaluate({ siteId, action, scheduledAt, scope, current, connection, effectiveStatus }) {
    if (action !== "publish") return { siteId, success: true, status: action === "delete" ? "deleted" : "withdrawn", detail: action === "delete" ? "Merkezi yayın içeriği bu siteden silindi; diğer siteler değişmedi." : "Yayın alanından kaldırıldı; içerik taslağı korundu." };
    const keep: TargetState = current ? (effectiveStatus === "published" ? current.status : "failed") : "failed";
    if (!connection || !connection.verified) {
      const reason = !connection ? "Bağlantı kurulmadı. Siteler ekranından yayın alanını doğrula." : connection.detail || "Bağlantı doğrulanmadı. Siteler ekranından bağlantıyı doğrula.";
      // "All connected sites": unverified sites are skipped with a warning, not failed.
      if (scope === "all-connected") return { siteId, success: false, skipped: true, status: current?.status ?? "draft", detail: `Doğrulanmamış site atlandı. ${reason}` };
      return { siteId, success: false, status: keep, detail: reason };
    }
    return { siteId, success: true, status: scheduledAt ? "scheduled" : "published", detail: scheduledAt ? "Zamanlı merkezi yayına alındı. Tarih geldiğinde yayın alanı otomatik gösterir." : "Doğrulanmış sitenin merkezi yayın alanında aktif." };
  },
};

export const publishChannels: Record<string, PublishChannel> = { [siteFeedChannel.id]: siteFeedChannel };
export const defaultChannel = siteFeedChannel;
