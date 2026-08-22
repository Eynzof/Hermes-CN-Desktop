import { Folder, FolderGit2, GitBranch, MessageSquare } from "lucide-react";
import type { ProjectTreeNode, ProjectTreeRepo, ProjectTreeLane, ProjectTreeSession } from "@hermes/protocol";
import s from "./project-tree.module.css";

interface ProjectTreeProps {
  tree: ProjectTreeNode[];
  onSessionClick?: (session: ProjectTreeSession) => void;
}

function SessionItem({ session, onClick }: { session: ProjectTreeSession; onClick?: (s: ProjectTreeSession) => void }) {
  return (
    <button type="button" className={s.session} onClick={() => onClick?.(session)}>
      <MessageSquare size={12} aria-hidden="true" />
      <span className="truncate">{session.title || session.session_id}</span>
      {session.branch ? (
        <span className={s.branch}>
          <GitBranch size={12} aria-hidden="true" />
          {session.branch}
        </span>
      ) : null}
    </button>
  );
}

function LaneItem({ lane, onSessionClick }: { lane: ProjectTreeLane; onSessionClick?: (s: ProjectTreeSession) => void }) {
  return (
    <div className={s.lane}>
      <div className={s.laneName}>{lane.name}</div>
      {lane.sessions?.map((session) => (
        <SessionItem key={session.session_id} session={session} onClick={onSessionClick} />
      ))}
    </div>
  );
}

function RepoItem({ repo, onSessionClick }: { repo: ProjectTreeRepo; onSessionClick?: (s: ProjectTreeSession) => void }) {
  return (
    <div className={s.repo}>
      <div className={s.repoHeader}>
        <FolderGit2 size={16} aria-hidden="true" />
        <span className="truncate">{repo.label || repo.root}</span>
      </div>
      {repo.lanes?.map((lane, index) => (
        <LaneItem key={`${lane.name}-${index}`} lane={lane} onSessionClick={onSessionClick} />
      ))}
    </div>
  );
}

function ProjectItem({ node, onSessionClick }: { node: ProjectTreeNode; onSessionClick?: (s: ProjectTreeSession) => void }) {
  const project = node.project;
  return (
    <div className={s.project}>
      <div className={s.projectHeader}>
        <Folder
          size={16}
          aria-hidden="true"
          className={s.projectIcon}
          color={project.color || "currentColor"}
        />
        <span className="truncate">{project.name}</span>
      </div>
      {node.repos?.map((repo) => (
        <RepoItem key={repo.root} repo={repo} onSessionClick={onSessionClick} />
      ))}
      {node.no_project_sessions?.map((session) => (
        <SessionItem key={session.session_id} session={session} onClick={onSessionClick} />
      ))}
    </div>
  );
}

export function ProjectTree({ tree, onSessionClick }: ProjectTreeProps) {
  return (
    <div className={s.tree} role="tree">
      {tree.map((node) => (
        <ProjectItem key={node.project.id} node={node} onSessionClick={onSessionClick} />
      ))}
    </div>
  );
}
