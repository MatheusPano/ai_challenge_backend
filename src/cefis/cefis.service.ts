import { Injectable, Logger } from '@nestjs/common';

const V3 = 'https://api-v3.cefis.com.br';

export type CefisCourse = {
  id: number;
  title: string;
  subtitle?: string;
  summary?: string;
  goals?: string[];
  banner?: string;
  duration?: number;
  lessonCount?: number;
  averageRating?: number;
  categories?: number[];
  teacher?: { id: number; name: string; avatar?: string };
  keywords?: string;
  crcActive?: boolean;
  crcCreditHours?: number | null;
};

@Injectable()
export class CefisService {
  private readonly log = new Logger(CefisService.name);

  async getCourse(
    sessionKey: string,
    id: number,
  ): Promise<(CefisCourse & { progress?: unknown }) | null> {
    try {
      const r = await fetch(`${V3}/courses/${id}`, {
        headers: {
          Authorization: `Bearer ${sessionKey}`,
          Accept: 'application/json',
        },
      });
      if (!r.ok) {
        this.log.error(`CEFIS v3 course/${id} ${r.status}`);
        return null;
      }
      const data = (await r.json()) as {
        data?: CefisCourse & { progress?: unknown };
      };
      return data.data ?? null;
    } catch (e) {
      this.log.error(`CEFIS course exception: ${(e as Error).message}`);
      return null;
    }
  }

  async listCoursesByCategories(
    sessionKey: string,
    categoryIds: number[],
    count = 12,
    filters: string[] = [],
  ): Promise<CefisCourse[]> {
    if (!categoryIds.length) return [];
    const qs = new URLSearchParams();
    qs.set('count', String(count));
    qs.set('order', 'averageRating');
    qs.set('orderDirection', 'desc');
    categoryIds.forEach((id) => qs.append('categories[]', String(id)));
    filters.forEach((f) => qs.append('filter[]', f));
    try {
      const r = await fetch(`${V3}/courses?${qs}`, {
        headers: {
          Authorization: `Bearer ${sessionKey}`,
          Accept: 'application/json',
        },
      });
      if (!r.ok) {
        this.log.error(`CEFIS v3 courses ${r.status}: ${await r.text()}`);
        return [];
      }
      const data = (await r.json()) as { data?: CefisCourse[] };
      return data.data ?? [];
    } catch (e) {
      this.log.error(`CEFIS exception: ${(e as Error).message}`);
      return [];
    }
  }
}
