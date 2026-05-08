# Note Loom

English | [简体中文](./README.zh-CN.md)

Note Loom is an Obsidian plugin that turns free-form notes into structured notes using your own templates. You can write freely first, then preview, adjust, and confirm before generating the final note.

## Quickstart

1. Import templates
   Open `Settings -> Community plugins -> Note Loom`, choose your template root folder, and import the Markdown templates you want to use.

2. Configure a template
   Click `Edit` in the template list. Confirm the output folder, filename field, field aliases, and sections you want Note Loom to generate. Simple templates can usually keep the defaults.

3. Open a source note
   Open an Inbox note, meeting note, reading excerpt, project note, or any Markdown note you want to process.

4. Start generation
   Open the Obsidian command palette, search for `Generate Structured Note`, and run it. You can also click the left Ribbon icon, then choose a template.

5. Preview and confirm
   In the generation modal, review fields, sections, output path, and preview content. Adjust anything you need, then generate the structured note.

## Minimal Example

Source note:

```text
Title: Progressive reading
Topic: How to turn a book into reusable concept notes
Core idea: Start with questions, organize ideas, then turn them into actions.
Next step: Write a concept note and link it to the reading index.
```

Template:

```md
---
title: {{Title}}
tags:
---

# {{Title}}

## Topic
{{Topic}}

## Core idea
{{Core idea}}

## Next step
{{Next step}}
```

Generated note:

```md
---
title: Progressive reading
tags:
---

# Progressive reading

## Topic
How to turn a book into reusable concept notes

## Core idea
Start with questions, organize ideas, then turn them into actions.

## Next step
Write a concept note and link it to the reading index.
```

## What It Handles

- Works best with static and semi-dynamic Markdown templates: headings, paragraphs, lists, field blocks, tables, and task lists.
- Uses `{{field name}}` as the main placeholder syntax, and can write to frontmatter, repeated body fields, and Dataview inline fields.
- Supports common structured sections: single-record field blocks, grouped field blocks, repeatable entries, Markdown tables, task lists, and checkbox option groups.
- Plays well with common Templater and Dataview usage: simple Templater values such as dates can be processed, while Dataview queries and script-driven display blocks are preserved with review hints.
- Generates a new note from the currently open Markdown note, matching content by field names, field aliases, section aliases, and clear punctuation boundaries.
- Lets you preview, edit, disable fields, and confirm the output path, filename, and index behavior before generation.

## Tips

- Matching is most stable when a field name or alias is followed by common punctuation. For example: `Title: Progressive reading` or `Next step, write a concept note`.
- If the source note does not mention a field name and you have not configured an alias for it, Note Loom will not guess the field from meaning alone.
- For section content, include the section title or a section alias. For tables, lists, and repeatable records, keep item boundaries clear.
- When using a new template for the first time, generate one or two test notes before using it in your regular workflow.

## Good Fits

- Reading notes and article excerpts: write down the passage, question, or next step first, then generate a reading note, summary, or concept-card template.
- Meetings and discussions: quickly capture decisions, action items, owners, and risks, then generate a meeting note or project tracking template.
- Project updates and reviews: record progress, blockers, evidence, and next steps, then generate a project status, review, or checklist template.
- Journals and time logs: write the day as it actually happened, then generate a journal, time log, or habit tracking template.

## Why Use It

Many Obsidian setups do not need more templates. They need a path from Inbox notes to finished notes.

Note Loom moves loose notes into the knowledge bases, project systems, meeting records, or journals you already designed. It handles repetitive copying, field alignment, and structure cleanup, while leaving judgment, selection, and confirmation to you.

The result: you do not have to clear your Inbox by willpower, and you do not have to spend your best organizing time on mechanical copy-and-paste work.
