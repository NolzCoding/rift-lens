"use client";

import { useRef, useState } from "react";
import { FileUp, LoaderCircle, ScanSearch, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";

export function UploadZone({
  loading,
  onAnalyze,
}: {
  loading: boolean;
  onAnalyze: (file: File, deep: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [deep, setDeep] = useState(true);
  const [dragging, setDragging] = useState(false);

  const choose = (candidate?: File) => {
    if (candidate?.name.toLowerCase().endsWith(".rofl")) setFile(candidate);
  };

  return (
    <div
      className={`upload-shell ${dragging ? "upload-dragging" : ""}`}
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        choose(event.dataTransfer.files[0]);
      }}
    >
      <input
        ref={input}
        type="file"
        accept=".rofl"
        className="hidden"
        onChange={(event) => choose(event.target.files?.[0])}
      />
      <div className="flex min-w-0 items-center gap-4">
        <div className="upload-icon"><FileUp size={22} /></div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white">
            {file ? file.name : "Drop a League replay here"}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {file ? `${(file.size / 1024 / 1024).toFixed(1)} MB ready to analyze` : "or choose a .rofl file from your replay folder"}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="mode-toggle">
          <button className={!deep ? "active" : ""} onClick={() => setDeep(false)}><Zap size={13} /> Quick</button>
          <button className={deep ? "active" : ""} onClick={() => setDeep(true)}><ScanSearch size={13} /> Deep</button>
        </div>
        <Button variant="ghost" onClick={() => input.current?.click()} disabled={loading}>Choose file</Button>
        <Button onClick={() => file && onAnalyze(file, deep)} disabled={!file || loading}>
          {loading ? <><LoaderCircle size={16} className="animate-spin" /> Analyzing</> : <>Analyze replay <span>↗</span></>}
        </Button>
      </div>
    </div>
  );
}
