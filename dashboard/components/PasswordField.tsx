"use client";

import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { FieldShell, describeField } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** A password input with a show/hide button, for a form that submits to an action. Controlled: the form keeps the value. */
export function PasswordField({
  id,
  name,
  label,
  help,
  error,
  value,
  onChange,
  autoComplete,
  autoFocus,
}: {
  id: string;
  name: string;
  label: ReactNode;
  help?: ReactNode;
  error?: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  autoFocus?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <FieldShell id={id} label={label} help={help} error={error}>
      <div className="relative">
        <Input
          name={name}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          spellCheck={false}
          className="pr-10"
          {...describeField(id, Boolean(help), error)}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="absolute top-1/2 right-1.5 -translate-y-1/2"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </Button>
      </div>
    </FieldShell>
  );
}
