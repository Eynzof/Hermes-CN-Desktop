import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Wand2 } from "lucide-react";
import { useActiveProfileName } from "@/hooks/use-profiles";
import {
  disablePet,
  generatePet,
  getPetGallery,
  getPetThumb,
  hatchPet,
  selectPet,
  setPetScale,
  type GalleryPet,
  type PetDraft,
} from "@/lib/pet";
import s from "./pet-settings.module.css";

function PetThumb({ pet, profile }: { pet: GalleryPet; profile?: string }) {
  const thumb = useQuery({
    queryKey: ["pet-thumb", profile, pet.slug, pet.spritesheetUrl],
    queryFn: () => getPetThumb(pet.slug, pet.spritesheetUrl, profile),
    staleTime: Infinity,
  });
  return (
    <div className={s.thumb}>
      {thumb.data?.dataUri ? <img src={thumb.data.dataUri} alt={pet.displayName} /> : <span>pet</span>}
    </div>
  );
}

export function PetSettingsPanel() {
  const profile = useActiveProfileName();
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [style, setStyle] = useState("auto");
  const [count, setCount] = useState(4);
  const [drafts, setDrafts] = useState<PetDraft[]>([]);
  const [token, setToken] = useState("");
  const [selectedDraft, setSelectedDraft] = useState(0);
  const [scale, setScale] = useState(0.33);
  const [error, setError] = useState("");

  const gallery = useQuery({
    queryKey: ["pet-gallery", profile],
    queryFn: () => getPetGallery(profile),
    staleTime: 60_000,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["pet-gallery", profile] });
  };

  const adoptMutation = useMutation({
    mutationFn: (slug: string) => selectPet(slug, profile),
    onSuccess: refresh,
  });
  const disableMutation = useMutation({
    mutationFn: () => disablePet(profile),
    onSuccess: refresh,
  });
  const scaleMutation = useMutation({
    mutationFn: () => setPetScale(scale, profile),
  });
  const generateMutation = useMutation({
    mutationFn: () => generatePet({ prompt, count, style }, profile),
    onMutate: () => {
      setError("");
      setDrafts([]);
      setToken("");
    },
    onSuccess: (result) => {
      setToken(result.token);
      setDrafts(result.drafts);
      setSelectedDraft(result.drafts[0]?.index ?? 0);
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });
  const hatchMutation = useMutation({
    mutationFn: async () => {
      const hatched = await hatchPet({ token, index: selectedDraft, name, prompt, style }, profile);
      await selectPet(hatched.slug, profile);
      return hatched;
    },
    onSuccess: () => {
      setDrafts([]);
      setToken("");
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const active = gallery.data?.active;
  const pets = (gallery.data?.pets ?? []).filter((pet) => !/^clawd(-|$)/i.test(pet.slug)).slice(0, 24);

  return (
    <section className={s.panel}>
      <div className={s.head}>
        <div>
          <h3>桌面悬浮宠物</h3>
          <p className={s.muted}>选择 petdex 宠物，或生成并孵化自己的桌面宠物。</p>
        </div>
        <button className={s.btn} type="button" onClick={() => disableMutation.mutate()} disabled={disableMutation.isPending}>
          禁用
        </button>
      </div>

      <div className={s.controls}>
        <div className={s.row}>
          <label>
            缩放{" "}
            <input
              type="range"
              min="0.2"
              max="1"
              step="0.05"
              value={scale}
              onChange={(event) => setScale(Number(event.target.value))}
            />
          </label>
          <button className={s.btn} type="button" onClick={() => scaleMutation.mutate()} disabled={scaleMutation.isPending}>
            保存缩放
          </button>
        </div>
        <div className={s.gallery}>
          {pets.map((pet) => (
            <div className={s.pet} key={pet.slug}>
              <PetThumb pet={pet} profile={profile} />
              <div className={s.name} title={pet.displayName}>{pet.displayName}</div>
              <button className={s.btn} type="button" disabled={adoptMutation.isPending || active === pet.slug} onClick={() => adoptMutation.mutate(pet.slug)}>
                {active === pet.slug ? "使用中" : pet.installed ? "启用" : "安装并启用"}
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className={s.generator}>
        <div className={s.head}>
          <div>
            <h3>生成 / 孵化</h3>
            <p className={s.muted}>输入外观描述，生成草稿后选择一个孵化为完整 spritesheet。</p>
          </div>
        </div>
        <textarea className={s.textarea} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：一只像像素侦探的蓝色小猫，戴圆框眼镜" />
        <div className={s.row}>
          <input className={s.input} value={name} onChange={(event) => setName(event.target.value)} placeholder="宠物名字" />
          <select className={s.select} value={style} onChange={(event) => setStyle(event.target.value)}>
            <option value="auto">auto</option>
            <option value="pixel">pixel</option>
            <option value="soft">soft</option>
          </select>
          <select className={s.select} value={count} onChange={(event) => setCount(Number(event.target.value))}>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} 草稿</option>)}
          </select>
          <button className={s.btn} type="button" disabled={!prompt.trim() || generateMutation.isPending} onClick={() => generateMutation.mutate()}>
            <Wand2 size={14} /> {generateMutation.isPending ? "生成中..." : "生成草稿"}
          </button>
          <button className={s.btn} type="button" disabled={!token || !name.trim() || hatchMutation.isPending} onClick={() => hatchMutation.mutate()}>
            {hatchMutation.isPending ? "孵化中..." : "孵化并启用"}
          </button>
        </div>
        {error ? <div className={s.error}>{error}</div> : null}
        {drafts.length ? (
          <div className={s.drafts}>
            {drafts.map((draft) => (
              <button className={s.draft} type="button" key={draft.index} data-active={selectedDraft === draft.index ? "true" : undefined} onClick={() => setSelectedDraft(draft.index)}>
                <div className={s.thumb}><img src={draft.dataUri} alt={`draft ${draft.index + 1}`} /></div>
                <span>草稿 {draft.index + 1}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
