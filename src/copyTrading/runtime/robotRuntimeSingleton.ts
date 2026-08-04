import { RobotRuntimeManager } from './RobotRuntimeManager';

let instance: RobotRuntimeManager | null = null;

export function getRobotRuntimeManager(): RobotRuntimeManager {
  if (!instance) {
    instance = new RobotRuntimeManager();
  }
  return instance;
}

/** 测试或 worker shutdown 时重置单例 */
export function resetRobotRuntimeManagerForTests(): void {
  if (instance) {
    instance.clear();
  }
  instance = null;
}
