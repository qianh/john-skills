#!/usr/bin/env python3
"""
根据 git diff 和文件变更，自动评估 commit 类型（feat/fix/docs 等）
"""
import sys
import re
from typing import Dict, List, Tuple

# Conventional Commits 类型
COMMIT_TYPES = {
    'feat': '新功能',
    'fix': '修复',
    'docs': '文档',
    'style': '格式',
    'refactor': '重构',
    'perf': '性能优化',
    'test': '测试',
    'build': '构建系统',
    'ci': 'CI配置',
    'chore': '其他'
}

def analyze_file_changes(diff_text: str) -> Dict[str, any]:
    """
    分析文件变更内容
    """
    result = {
        'new_files': [],
        'modified_files': [],
        'deleted_files': [],
        'renamed_files': [],
        'doc_files': [],
        'test_files': [],
        'config_files': [],
        'code_files': []
    }
    
    lines = diff_text.split('\n')
    current_file = None
    
    for line in lines:
        if line.startswith('diff --git'):
            match = re.search(r'b/(.+)$', line)
            if match:
                current_file = match.group(1)
        elif line.startswith('new file mode'):
            if current_file:
                result['new_files'].append(current_file)
                categorize_file(current_file, result)
        elif line.startswith('deleted file mode'):
            if current_file:
                result['deleted_files'].append(current_file)
        elif line.startswith('rename from'):
            result['renamed_files'].append(current_file)
        elif current_file and current_file not in result['new_files'] and current_file not in result['deleted_files']:
            if current_file not in result['modified_files']:
                result['modified_files'].append(current_file)
                categorize_file(current_file, result)
    
    return result

def categorize_file(filename: str, result: Dict):
    """
    将文件归类
    """
    lower_name = filename.lower()
    
    # 文档文件
    if any(filename.endswith(ext) for ext in ['.md', '.txt', '.rst', '.adoc']):
        result['doc_files'].append(filename)
    # 测试文件
    elif 'test' in lower_name or filename.endswith('_test.py') or filename.endswith('.test.js') or filename.endswith('.spec.js'):
        result['test_files'].append(filename)
    # 配置文件
    elif any(filename.endswith(ext) for ext in ['.json', '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg']) or \
         any(name in lower_name for name in ['config', 'package.json', 'tsconfig', 'eslint', 'prettier', 'docker']):
        result['config_files'].append(filename)
    # 代码文件
    elif any(filename.endswith(ext) for ext in ['.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.php', '.rb']):
        result['code_files'].append(filename)

def analyze_diff_content(diff_text: str) -> Dict[str, int]:
    """
    分析 diff 内容特征
    """
    features = {
        'has_new_function': 0,
        'has_fix_keywords': 0,
        'has_refactor_keywords': 0,
        'has_performance_keywords': 0,
        'has_breaking_change': 0,
        'additions': 0,
        'deletions': 0
    }
    
    # 关键词匹配
    fix_keywords = ['fix', 'bug', 'error', '修复', '错误', 'bugfix', 'hotfix', 'patch']
    refactor_keywords = ['refactor', 'rename', 'reorganize', '重构', '重命名', '优化结构']
    perf_keywords = ['performance', 'optimize', 'faster', 'perf', '性能', '优化', 'cache']
    breaking_keywords = ['BREAKING CHANGE', 'breaking', '不兼容', '破坏性变更']
    
    lines = diff_text.split('\n')
    
    for line in lines:
        lower_line = line.lower()
        
        # 新增函数/类
        if line.startswith('+') and any(keyword in lower_line for keyword in ['def ', 'function ', 'class ', 'const ', 'let ', 'var ', 'export ']):
            features['has_new_function'] += 1
        
        # 修复相关
        if any(keyword in lower_line for keyword in fix_keywords):
            features['has_fix_keywords'] += 1
        
        # 重构相关
        if any(keyword in lower_line for keyword in refactor_keywords):
            features['has_refactor_keywords'] += 1
        
        # 性能相关
        if any(keyword in lower_line for keyword in perf_keywords):
            features['has_performance_keywords'] += 1
        
        # 破坏性变更
        if any(keyword in line for keyword in breaking_keywords):
            features['has_breaking_change'] += 1
        
        # 统计增删
        if line.startswith('+') and not line.startswith('+++'):
            features['additions'] += 1
        elif line.startswith('-') and not line.startswith('---'):
            features['deletions'] += 1
    
    return features

def determine_commit_type(file_changes: Dict, diff_features: Dict) -> Tuple[str, str, int]:
    """
    确定提交类型
    返回: (类型, 理由, 置信度)
    """
    reasons = []
    
    # 纯文档变更
    if file_changes['doc_files'] and not file_changes['code_files'] and not file_changes['test_files']:
        return 'docs', '仅修改文档文件', 95
    
    # 纯测试变更
    if file_changes['test_files'] and not file_changes['code_files']:
        return 'test', '仅修改测试文件', 95
    
    # CI/构建配置
    if any('.github' in f or '.gitlab' in f or 'jenkins' in f.lower() for f in file_changes['modified_files'] + file_changes['new_files']):
        return 'ci', '修改 CI/CD 配置', 90
    
    # 构建系统
    build_files = ['package.json', 'pom.xml', 'build.gradle', 'cargo.toml', 'setup.py', 'pyproject.toml']
    if any(any(bf in f.lower() for bf in build_files) for f in file_changes['modified_files'] + file_changes['new_files']):
        if not file_changes['code_files']:
            return 'build', '修改构建配置', 90
    
    # 修复判断
    if diff_features['has_fix_keywords'] >= 2:
        return 'fix', f"检测到 {diff_features['has_fix_keywords']} 处修复相关关键词", 85
    
    # 性能优化
    if diff_features['has_performance_keywords'] >= 2:
        return 'perf', f"检测到 {diff_features['has_performance_keywords']} 处性能优化相关内容", 80
    
    # 重构判断
    if diff_features['has_refactor_keywords'] >= 2:
        return 'refactor', f"检测到 {diff_features['has_refactor_keywords']} 处重构相关关键词", 80
    
    # 大量删除，可能是重构
    if diff_features['deletions'] > diff_features['additions'] * 1.5 and diff_features['deletions'] > 50:
        return 'refactor', '大量删除代码，可能是代码重构或清理', 70
    
    # 格式化变更
    if diff_features['additions'] > 0 and diff_features['deletions'] > 0:
        if abs(diff_features['additions'] - diff_features['deletions']) < 5:
            return 'style', '增删行数相近，可能是格式调整', 60
    
    # 新增文件
    if len(file_changes['new_files']) > 0 and diff_features['has_new_function'] > 2:
        return 'feat', f"新增 {len(file_changes['new_files'])} 个文件，包含多个新函数", 90
    
    # 有新功能特征
    if diff_features['has_new_function'] >= 3:
        return 'feat', f"新增 {diff_features['has_new_function']} 个函数/类/模块", 85
    
    # 代码变更但特征不明显
    if file_changes['code_files']:
        if diff_features['additions'] > diff_features['deletions'] * 2:
            return 'feat', '主要是新增代码', 75
        else:
            return 'feat', '包含代码变更', 60
    
    # 配置文件变更
    if file_changes['config_files']:
        return 'chore', '修改配置文件', 70
    
    # 默认
    return 'feat', '无法明确分类，默认为新功能', 50

def format_output(commit_type: str, reason: str, confidence: int, file_changes: Dict) -> str:
    """
    格式化输出
    """
    type_cn = COMMIT_TYPES.get(commit_type, commit_type)
    
    output = []
    output.append(f"推荐提交类型: {commit_type} ({type_cn})")
    output.append(f"判断依据: {reason}")
    output.append(f"置信度: {confidence}%")
    output.append("")
    output.append("变更统计:")
    output.append(f"  - 代码文件: {len(file_changes['code_files'])} 个")
    output.append(f"  - 测试文件: {len(file_changes['test_files'])} 个")
    output.append(f"  - 文档文件: {len(file_changes['doc_files'])} 个")
    output.append(f"  - 配置文件: {len(file_changes['config_files'])} 个")
    
    return '\n'.join(output)

def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1], 'r', encoding='utf-8') as f:
            diff_text = f.read()
    else:
        diff_text = sys.stdin.read()
    
    file_changes = analyze_file_changes(diff_text)
    diff_features = analyze_diff_content(diff_text)
    
    commit_type, reason, confidence = determine_commit_type(file_changes, diff_features)
    
    # 输出结果（第一行是类型，方便脚本调用）
    print(commit_type)
    print("---")
    print(format_output(commit_type, reason, confidence, file_changes))

if __name__ == '__main__':
    main()
